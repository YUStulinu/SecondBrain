/**
 * ingest.js — the indexing pipeline and the queue that runs it.
 *
 * Indexing is slow: extracting a 200-page PDF and embedding 400 chunks can
 * take a minute, and on the local model it saturates the CPU. So uploads
 * return immediately with a document id, the work happens on a queue of
 * one job at a time, and progress is pushed to the browser as it goes.
 *
 * One at a time is deliberate. Running four embeddings in parallel on a
 * laptop makes everything slower, not faster, and makes progress reporting
 * meaningless.
 *
 * Re-adding a file you already have is free: the content hash is checked
 * first, and an unchanged file is recognised rather than re-embedded.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const db = require('./db');
const { extract, extractionWarnings } = require('./extract');
const { chunkText, embeddableText } = require('./chunk');
const { embedBatched, currentConfig, probe } = require('./embed');

const events = new EventEmitter();
events.setMaxListeners(50);

const queue = [];
let running = false;
let currentJob = null;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const now = () => new Date().toISOString();

function emit(documentId, patch) {
  const payload = { documentId, at: Date.now(), ...patch };
  events.emit('progress', payload);
  return payload;
}

/* ---------------- adding documents ---------------- */

/**
 * Registers a document and queues it. Returns immediately.
 * `{ duplicate: true }` comes back when this exact content is already here.
 */
function addDocument({ buffer, filename, title, collection = '', sourceType = 'file', mime = '' }) {
  const d = db.open();
  const hash = sha256(buffer);

  const existing = d.prepare('SELECT id, title, status FROM documents WHERE content_hash = ?').get(hash);
  if (existing) {
    return { documentId: existing.id, duplicate: true, title: existing.title, status: existing.status };
  }

  const info = d.prepare(`
    INSERT INTO documents (title, source_type, filename, mime, byte_size, content_hash, collection, status, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    (title || filename || 'Untitled').slice(0, 300),
    sourceType, filename || null, mime || null, buffer.length, hash,
    String(collection || '').slice(0, 80), now()
  );

  const documentId = Number(info.lastInsertRowid);
  enqueue({ documentId, buffer, filename: filename || title || 'document.txt' });
  return { documentId, duplicate: false };
}

function enqueue(job) {
  queue.push(job);
  emit(job.documentId, { stage: 'queued', queuePosition: queue.length });
  runNext();
}

async function runNext() {
  if (running || !queue.length) return;
  running = true;
  currentJob = queue.shift();

  try {
    await processDocument(currentJob);
  } catch (err) {
    console.error('Ingest failed:', err);
    db.open().prepare("UPDATE documents SET status = 'failed', error = ? WHERE id = ?")
      .run(String(err.message).slice(0, 500), currentJob.documentId);
    emit(currentJob.documentId, { stage: 'failed', error: err.message });
  } finally {
    running = false;
    currentJob = null;
    // Give the event loop a tick so progress events flush before the next job.
    setImmediate(runNext);
  }
}

/* ---------------- the pipeline ---------------- */

async function processDocument({ documentId, buffer, filename }) {
  const d = db.open();

  // 1. Extract -----------------------------------------------------------
  d.prepare("UPDATE documents SET status = 'extracting', error = NULL WHERE id = ?").run(documentId);
  emit(documentId, { stage: 'extracting', percent: 5 });

  const { text, pages, pageCount } = await extract(buffer, filename);
  if (!text || text.trim().length < 20) {
    throw new Error('No readable text could be extracted. If this is a scanned document, it needs OCR first.');
  }

  const doc = d.prepare('SELECT title FROM documents WHERE id = ?').get(documentId);
  return processExtracted({ documentId, title: doc.title, text, pages, pageCount });
}

/**
 * Everything after extraction: chunk, embed, store. Kept separate so a
 * reindex can run the identical path from text that is already stored.
 */
async function processExtracted({ documentId, title, text, pages, pageCount }) {
  const d = db.open();
  const setStatus = d.prepare('UPDATE documents SET status = ?, error = NULL WHERE id = ?');
  const warnings = extractionWarnings({ text, pageCount });

  // 2. Chunk -------------------------------------------------------------
  setStatus.run('chunking', documentId);
  emit(documentId, { stage: 'chunking', percent: 15 });

  const chunks = chunkText(text, { pages });
  if (!chunks.length) throw new Error('The document produced no chunks.');

  // Replace any previous chunks for this document, so re-indexing is safe.
  const oldIds = d.prepare('SELECT id FROM chunks WHERE document_id = ?').all(documentId).map((r) => r.id);
  if (oldIds.length) {
    d.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(documentId);
    if (db.hasVectorTable()) {
      const del = d.prepare('DELETE FROM chunk_vectors WHERE rowid = ?');
      for (const id of oldIds) del.run(BigInt(id));
    }
  }

  const insertChunk = d.prepare(`
    INSERT INTO chunks (document_id, ordinal, text, heading, page, char_start, char_end, token_est)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const chunkIds = d.transaction(() => chunks.map((c, i) =>
    Number(insertChunk.run(documentId, i, c.text, c.heading || '', c.page, c.charStart, c.charEnd, c.tokenEst).lastInsertRowid)
  ))();

  // From here on the document has chunks but no vectors. If embedding fails
  // it must not be left in that state: the chunks would still answer keyword
  // searches while being invisible to semantic ones, which is worse than the
  // document simply being absent. So any failure rolls the chunks back.
  const rollbackChunks = () => {
    try {
      d.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
    } catch (err) {
      console.error('Could not roll back chunks for document', documentId, err.message);
    }
  };

  d.prepare(`
    UPDATE documents
    SET char_count = ?, page_count = COALESCE(?, page_count), extracted_text = ?, pages_json = ?
    WHERE id = ?
  `).run(text.length, pageCount || null, text, pages ? JSON.stringify(pages) : null, documentId);

  // 3. Embed -------------------------------------------------------------
  setStatus.run('embedding', documentId);
  emit(documentId, { stage: 'embedding', percent: 25, chunks: chunks.length });

  const texts = chunks.map((c) => embeddableText(c, title));

  try {
    const vectors = await embedBatched(texts, {
      kind: 'passage',
      onProgress: ({ done, total }) => emit(documentId, {
        stage: 'embedding',
        percent: 25 + Math.round((done / total) * 65),
        chunksDone: done,
        chunks: total
      })
    });

    // 4. Store vectors ---------------------------------------------------
    const config = ensureEmbeddingConfig(vectors[0].length);
    db.ensureVectorTable(config.dims);

    const insertVector = d.prepare('INSERT INTO chunk_vectors(rowid, embedding) VALUES (?, ?)');
    d.transaction(() => {
      vectors.forEach((vec, i) => {
        // better-sqlite3 will not bind a JS number as a vec0 rowid.
        insertVector.run(BigInt(chunkIds[i]), Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      });
    })();
  } catch (err) {
    rollbackChunks();
    throw err;
  }

  d.prepare("UPDATE documents SET status = 'ready', indexed_at = ?, error = ? WHERE id = ?")
    .run(now(), warnings.length ? warnings.join(' ') : null, documentId);

  emit(documentId, { stage: 'ready', percent: 100, chunks: chunks.length, warnings });
  return { chunks: chunks.length, warnings };
}

/**
 * Records which model built the index, and refuses to mix two models in
 * one index — their vectors are not comparable, and the failure would show
 * up as quietly terrible search results rather than an error.
 */
function ensureEmbeddingConfig(dims) {
  const { provider, model } = currentConfig();
  const stored = db.getEmbeddingConfig();

  if (!stored) {
    const config = { provider, model, dims };
    db.setEmbeddingConfig(config);
    return config;
  }

  if (stored.model !== model || stored.dims !== dims) {
    throw new Error(
      `This index was built with "${stored.model}" (${stored.dims} dimensions) but the current setting is ` +
      `"${model}" (${dims} dimensions). Vectors from two models cannot be compared.\n` +
      'Either restore the previous EMBEDDING_MODEL in .env, or run `npm run reindex` to rebuild with the new one.'
    );
  }
  return stored;
}

/* ---------------- maintenance ---------------- */

function deleteDocument(documentId) {
  const d = db.open();
  const ids = d.prepare('SELECT id FROM chunks WHERE document_id = ?').all(documentId).map((r) => r.id);
  if (db.hasVectorTable() && ids.length) {
    const del = d.prepare('DELETE FROM chunk_vectors WHERE rowid = ?');
    d.transaction(() => { for (const id of ids) del.run(BigInt(id)); })();
  }
  return d.prepare('DELETE FROM documents WHERE id = ?').run(documentId).changes > 0;
}

/**
 * Rebuilds chunks and vectors for a document from the text already stored,
 * without needing the original file. This is the path used after changing
 * the embedding model.
 */
async function reindexDocument(documentId) {
  const d = db.open();
  const doc = d.prepare('SELECT id, title, extracted_text, pages_json FROM documents WHERE id = ?').get(documentId);
  if (!doc) throw new Error('Document not found.');
  if (!doc.extracted_text) {
    throw new Error(`"${doc.title}" was added before the text was being kept, so it has to be uploaded again.`);
  }

  try {
    return await processExtracted({
      documentId,
      title: doc.title,
      text: doc.extracted_text,
      pages: doc.pages_json ? JSON.parse(doc.pages_json) : null,
      pageCount: null
    });
  } catch (err) {
    // This path runs outside the queue, so it has to record its own failure
    // rather than leaving the document stuck mid-pipeline.
    d.prepare("UPDATE documents SET status = 'failed', error = ? WHERE id = ?")
      .run(String(err.message).slice(0, 500), documentId);
    emit(documentId, { stage: 'failed', error: err.message });
    throw err;
  }
}

/**
 * A document left in a working state belongs to a run that died — a crash,
 * a Ctrl-C mid-embed. Nothing will ever move it forward, so on startup it
 * is cleaned up and marked failed, which at least makes it visible and
 * re-addable instead of stuck at 40% forever.
 */
function recoverInterrupted() {
  const d = db.open();
  const stuck = d.prepare(`
    SELECT id, title, extracted_text IS NOT NULL AS has_text
    FROM documents WHERE status IN ('extracting','chunking','embedding')
  `).all();
  if (!stuck.length) return [];

  const rebuilt = [];
  const lost = [];

  for (const doc of stuck) {
    d.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);

    if (doc.has_text) {
      // The extracted text survived, so the document can be rebuilt here
      // rather than asking for the original file back.
      d.prepare("UPDATE documents SET status = 'pending', error = NULL WHERE id = ?").run(doc.id);
      rebuilt.push(doc);
    } else {
      // It died during extraction, before there was any text to keep.
      d.prepare("UPDATE documents SET status = 'failed', error = ? WHERE id = ?")
        .run('Indexing was interrupted before any text was read. Add this document again.', doc.id);
      lost.push(doc);
    }
  }

  if (lost.length) {
    console.warn(`${lost.length} document(s) could not be recovered and need re-adding: ${lost.map((x) => x.title).join(', ')}`);
  }

  if (rebuilt.length) {
    console.warn(`Rebuilding ${rebuilt.length} document(s) left half-indexed by an earlier run: ${rebuilt.map((x) => x.title).join(', ')}`);
    // Queued behind a tick so the server is listening before work starts.
    setImmediate(async () => {
      for (const doc of rebuilt) {
        try { await reindexDocument(doc.id); }
        catch (err) { console.error(`Could not rebuild "${doc.title}":`, err.message); }
      }
    });
  }

  return stuck;
}

function queueState() {
  return {
    running: Boolean(currentJob),
    currentDocumentId: currentJob?.documentId ?? null,
    pending: queue.length
  };
}

module.exports = { addDocument, processDocument, reindexDocument, recoverInterrupted, deleteDocument, events, queueState, probe };
