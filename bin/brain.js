#!/usr/bin/env node
/**
 * brain — the command line, for AI agents and scripts. The same indexing, hybrid search and
 * citation check the app uses, as JSON on standard output, with no server and no API key: the
 * agent writes the answer, and `check` holds its quotes to the passages they name.
 *
 *   brain add <files...> [--collection C]       index PDF, DOCX, TXT, Markdown or HTML (waits)
 *   brain list                                  the documents, their status and chunk counts
 *   brain search "<question>" [--limit 8] [--collection C] [--mode hybrid|keyword|vector]
 *   brain show <passage id> [--around 1]        a passage with its neighbours, for context
 *   brain check <answer.json>                   verify an answer's citations
 *   brain remove <document id>
 *
 * answer.json: {"answer": "... [S1] ...", "citations": [{"marker": "S1", "passageId": 12,
 * "quote": "..."}], "confidence": "high"|"partial"|"none", "missing": "..."}
 *
 * The library lives in data/brain.db next to the program (DB_FILE or --db to change it), and
 * settings come from its .env. Embeddings are local by default (npm run setup:local, once).
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const USAGE = `usage:
  brain add <files...> [--collection C]
  brain list
  brain search "<question>" [--limit 8] [--collection C] [--mode hybrid|keyword|vector]
  brain show <passage id> [--around 1]
  brain check <answer.json>
  brain remove <document id>
common: --db <file>`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? argv[++i];
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 1) + '\n');
}

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function add(files, collection, db, ingest) {
  if (!files.length) fail('add: name the files to index', 2);
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) {
      out.push({ file: f, status: 'failed', error: 'no such file' });
      continue;
    }
    const name = path.basename(f);
    const r = ingest.addDocument({ buffer: fs.readFileSync(f), filename: name, title: name, collection: collection || '' });
    out.push({ file: f, documentId: r.documentId, duplicate: r.duplicate });
  }
  // The queue runs in this process: wait for each document to finish.
  const d = db.open();
  for (const r of out) {
    if (!r.documentId) continue;
    for (;;) {
      const row = d.prepare('SELECT status, error FROM documents WHERE id = ?').get(r.documentId);
      if (!row || row.status === 'ready' || row.status === 'failed') {
        r.status = row ? row.status : 'failed';
        if (row?.error) r.error = row.error;
        break;
      }
      await sleep(200);
    }
    r.passages = d.prepare('SELECT count(*) AS n FROM chunks WHERE document_id = ?').get(r.documentId).n;
  }
  return out;
}

function list(db) {
  return db.open().prepare(`
    SELECT d.id, d.title, d.collection, d.status, d.error,
           (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS passages
    FROM documents d ORDER BY d.id`).all();
}

function passage(row) {
  return { id: row.id, document: row.title, documentId: row.document_id, heading: row.heading || null, page: row.page || null, text: row.text };
}

function show(id, around, db) {
  const d = db.open();
  const hit = d.prepare(`SELECT c.*, doc.title FROM chunks c JOIN documents doc ON doc.id = c.document_id WHERE c.id = ?`).get(id);
  if (!hit) fail(`no passage with id ${id}`);
  const rows = d.prepare(`SELECT c.*, doc.title FROM chunks c JOIN documents doc ON doc.id = c.document_id
    WHERE c.document_id = ? AND c.ordinal BETWEEN ? AND ? ORDER BY c.ordinal`).all(hit.document_id, hit.ordinal - around, hit.ordinal + around);
  return { passage: passage(hit), around: rows.filter((r) => r.id !== hit.id).map(passage) };
}

/**
 * The app's check (answer.js verify) on an answer written elsewhere: every citation must name a
 * passage that exists and quote words that appear in it. Markers whose citation fails become
 * [unverified] in the answer, and the confidence is lowered when too many fail.
 */
function check(file, db, verify) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${file}: not readable JSON (${err.message})`);
  }
  const d = db.open();
  const get = d.prepare(`SELECT c.id, c.document_id, c.ordinal, c.text, c.heading, c.page, doc.title
    FROM chunks c JOIN documents doc ON doc.id = c.document_id WHERE c.id = ?`);
  const used = [];
  const missing = [];
  const citations = [];
  for (const c of parsed.citations || []) {
    const marker = String(c?.marker || '').trim().toUpperCase();
    const id = Number(c?.passageId);
    const row = Number.isInteger(id) ? get.get(id) : null;
    if (!row) {
      missing.push({ marker, quote: String(c?.quote || ''), reason: `no passage with id ${c?.passageId}` });
      continue;
    }
    if (!used.some((u) => u.label === marker)) {
      used.push({ label: marker, chunkId: row.id, documentId: row.document_id, documentTitle: row.title,
        heading: row.heading, page: row.page, ordinal: row.ordinal, text: row.text });
    }
    citations.push(c);
  }
  const result = verify({ ...parsed, citations }, used);
  result.verification.checked += missing.length;
  result.verification.dropped.push(...missing);
  // Markers whose only citation named a missing passage.
  for (const m of missing) result.answer = result.answer.replaceAll(`[${m.marker}]`, '[unverified]');
  const total = result.verification.kept + result.verification.dropped.length;
  if (!result.citations.length && result.confidence !== 'none') result.confidence = 'partial';
  else if (total && result.verification.dropped.length / total >= 0.34 && result.confidence === 'high') result.confidence = 'partial';
  delete result.usage;
  return result;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const { flags, pos } = parseArgs(rest);
  if (flags.db) process.env.DB_FILE = path.resolve(flags.db);

  const db = require('../lib/db');
  try {
    switch (cmd) {
      case 'add': {
        const ingest = require('../lib/ingest');
        print(await add(pos, flags.collection, db, ingest));
        break;
      }
      case 'list':
        print(list(db));
        break;
      case 'search': {
        const q = pos.join(' ').trim();
        if (!q) fail('search: give a question', 2);
        const { search } = require('../lib/search');
        const r = await search(q, { limit: Number(flags.limit) || 8, collection: flags.collection || null, mode: flags.mode || 'hybrid' });
        print({
          question: q,
          results: r.results.map((x) => ({ id: x.chunkId, document: x.documentTitle, documentId: x.documentId,
            heading: x.heading || null, page: x.page || null, ranks: x.ranks, text: x.text })),
          ...(r.timings.vectorError ? { warning: `vector search unavailable: ${r.timings.vectorError}` } : {})
        });
        break;
      }
      case 'show':
        print(show(Number(pos[0]), Number(flags.around ?? 1), db));
        break;
      case 'check': {
        if (!pos[0]) fail('check: name the answer.json file', 2);
        const { verify } = require('../lib/answer');
        print(check(pos[0], db, verify));
        break;
      }
      case 'remove': {
        const { deleteDocument } = require('../lib/ingest');
        print({ removed: deleteDocument(Number(pos[0])) });
        break;
      }
      default:
        fail(`unknown command "${cmd}"\n${USAGE}`, 2);
    }
  } finally {
    db.close();
  }
}

// The embedding model's worker threads would otherwise keep the process alive after the answer.
main().then(() => process.exit(0), (err) => fail(err.message));
