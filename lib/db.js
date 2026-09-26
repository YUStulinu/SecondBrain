/**
 * db.js — one SQLite file holds everything: the documents, their chunks,
 * a full-text index for keyword search, and a vector index for meaning.
 *
 * Why one database instead of a separate vector service? At personal scale
 * — even a hundred thousand chunks — a single file is faster to query than
 * a network hop, needs no server running alongside, and can be backed up by
 * copying one file. The moment you outgrow it, the same schema maps onto
 * Postgres with pgvector.
 *
 * Two indexes, because they fail in opposite ways:
 *   - FTS5 (BM25) finds exact words: names, error codes, "TCP", "Art. 1350".
 *     It cannot find "handshake" when you ask about "stabilirea conexiunii".
 *   - Vectors find meaning, including across languages, but happily miss a
 *     rare literal token because it barely moves the embedding.
 * Searching both and merging is what makes retrieval reliable.
 */
const path = require('path');
const fs = require('fs');

// better-sqlite3 v13 needs Node 22 or newer. Without this check, an older
// Node fails deep inside a native module with an error that says nothing
// about the actual cause.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  console.error(
    `\nSecond Brain needs Node 22 or newer — you are running ${process.versions.node}.\n` +
    'Install a current version from https://nodejs.org and run `npm install` again.\n'
  );
  process.exit(1);
}

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'brain.db');

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new Database(DB_FILE);

  // WAL lets reads continue while a long ingest is writing.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  try {
    sqliteVec.load(db);
  } catch (err) {
    throw new Error(
      'Could not load the sqlite-vec extension: ' + err.message +
      '\nTry: npm install sqlite-vec --force'
    );
  }

  migrate(db);
  return db;
}

/**
 * Migrations are a numbered list. Each runs once, in order, and the schema
 * version is stored in the file itself, so an existing database upgrades
 * in place instead of needing to be rebuilt.
 */
const MIGRATIONS = [
  function initial(d) {
    d.exec(`
      CREATE TABLE documents (
        id            INTEGER PRIMARY KEY,
        title         TEXT NOT NULL,
        source_type   TEXT NOT NULL,          -- 'file' | 'text' | 'url'
        filename      TEXT,
        mime          TEXT,
        byte_size     INTEGER,
        content_hash  TEXT NOT NULL,          -- lets re-ingest skip unchanged files
        char_count    INTEGER DEFAULT 0,
        page_count    INTEGER,
        collection    TEXT DEFAULT '',        -- a folder-like label, e.g. "Networking"
        status        TEXT NOT NULL DEFAULT 'pending',  -- pending|extracting|chunking|embedding|ready|failed
        error         TEXT,
        added_at      TEXT NOT NULL,
        indexed_at    TEXT
      );

      CREATE UNIQUE INDEX idx_documents_hash ON documents(content_hash);
      CREATE INDEX idx_documents_status ON documents(status);

      CREATE TABLE chunks (
        id           INTEGER PRIMARY KEY,
        document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal      INTEGER NOT NULL,        -- position of this chunk in the document
        text         TEXT NOT NULL,
        heading      TEXT DEFAULT '',         -- nearest heading above, kept for context
        page         INTEGER,                 -- page number for PDFs
        char_start   INTEGER NOT NULL,        -- offset in the extracted text, for highlighting
        char_end     INTEGER NOT NULL,
        token_est    INTEGER NOT NULL
      );

      CREATE INDEX idx_chunks_document ON chunks(document_id);

      -- External-content FTS5: the text lives in the chunks table, the index
      -- only holds the search structures, so nothing is stored twice.
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        heading,
        content     = 'chunks',
        content_rowid = 'id',
        tokenize    = "unicode61 remove_diacritics 2"
      );

      -- Keep the FTS index in step with the table automatically.
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
      END;
      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
      END;
      CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
        INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
      END;

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Asked questions, so the app can show a history and re-open an answer.
      CREATE TABLE queries (
        id          INTEGER PRIMARY KEY,
        question    TEXT NOT NULL,
        answer      TEXT,
        citations   TEXT,                     -- JSON
        stats       TEXT,                     -- JSON: timings, how many chunks, which route
        asked_at    TEXT NOT NULL
      );
    `);
  },

  function keepExtractedText(d) {
    // Changing the embedding model means every vector has to be rebuilt.
    // Without the text, that would mean asking the user to find and upload
    // every original file again. Keeping the extracted text — a fraction of
    // the size of a PDF — makes re-chunking and re-embedding a local job.
    d.exec(`
      ALTER TABLE documents ADD COLUMN extracted_text TEXT;
      ALTER TABLE documents ADD COLUMN pages_json TEXT;
    `);
  }
];

function migrate(d) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = d.prepare('SELECT version FROM schema_version').get();
  let current = row ? row.version : 0;
  if (!row) d.prepare('INSERT INTO schema_version(version) VALUES (0)').run();

  for (let i = current; i < MIGRATIONS.length; i++) {
    const run = d.transaction(() => {
      MIGRATIONS[i](d);
      d.prepare('UPDATE schema_version SET version = ?').run(i + 1);
    });
    run();
    current = i + 1;
  }
}

/* ---------------- embedding configuration ---------------- */

/**
 * The vector table's width is fixed when it's created, and different
 * embedding models produce different widths. The configuration used to
 * build the index is recorded here so a mismatch is caught with a clear
 * message instead of silently returning nonsense.
 */
function getEmbeddingConfig() {
  const d = open();
  const row = d.prepare("SELECT value FROM meta WHERE key = 'embedding'").get();
  return row ? JSON.parse(row.value) : null;
}

function setEmbeddingConfig(config) {
  const d = open();
  d.prepare("INSERT INTO meta(key, value) VALUES ('embedding', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(config));
}

/** Creates the vector table for a given width, once the width is known. */
function ensureVectorTable(dims) {
  const d = open();
  const exists = d.prepare("SELECT name FROM sqlite_master WHERE name = 'chunk_vectors'").get();
  if (!exists) {
    d.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[${Number(dims)}])`);
  }
  return d;
}

function hasVectorTable() {
  return Boolean(open().prepare("SELECT name FROM sqlite_master WHERE name = 'chunk_vectors'").get());
}

/** Drops every chunk, the FTS rows and the vectors, keeping the documents. */
function clearIndex() {
  const d = open();
  d.exec('DELETE FROM chunks');
  if (hasVectorTable()) d.exec('DROP TABLE chunk_vectors');
  d.prepare("DELETE FROM meta WHERE key = 'embedding'").run();
  d.prepare("UPDATE documents SET status = 'pending', indexed_at = NULL").run();
}

function stats() {
  const d = open();
  const docs = d.prepare("SELECT status, COUNT(*) n FROM documents GROUP BY status").all();
  const byStatus = Object.fromEntries(docs.map((r) => [r.status, r.n]));
  return {
    documents: docs.reduce((a, r) => a + r.n, 0),
    byStatus,
    chunks: d.prepare('SELECT COUNT(*) n FROM chunks').get().n,
    vectors: hasVectorTable() ? d.prepare('SELECT COUNT(*) n FROM chunk_vectors').get().n : 0,
    embedding: getEmbeddingConfig(),
    // In WAL mode recent writes sit in the -wal file until a checkpoint,
    // so reporting only the main file makes a full database look empty.
    fileSize: ['', '-wal', '-shm'].reduce((total, suffix) => {
      const p = DB_FILE + suffix;
      return total + (fs.existsSync(p) ? fs.statSync(p).size : 0);
    }, 0)
  };
}

module.exports = {
  open, DB_FILE,
  getEmbeddingConfig, setEmbeddingConfig,
  ensureVectorTable, hasVectorTable,
  clearIndex, stats
};
