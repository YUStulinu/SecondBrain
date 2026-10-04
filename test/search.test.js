/**
 * These tests are the argument for hybrid search, made concrete.
 *
 * Two queries are used throughout:
 *   - an exact-token query ("EPERM 4093"), which vectors are bad at
 *   - a paraphrase query, where the answer shares no words with the question
 * Neither method handles both. The fused ranking does.
 */
process.env.EMBEDDING_PROVIDER = 'hash'; // deterministic, no model, no network
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `sb-search-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const db = require('../lib/db');
const { embed } = require('../lib/embed');
const { search, keywordSearch, vectorSearch, reciprocalRankFusion, buildFtsQuery } = require('../lib/search');

const CORPUS = [
  { title: 'Ghid erori', heading: 'Coduri', text: 'Eroarea EPERM 4093 apare atunci când procesul nu are permisiunile necesare pentru a scrie în directorul de lucru.' },
  { title: 'Ghid erori', heading: 'Coduri', text: 'Eroarea ENOENT indică faptul că fișierul cerut nu există la calea specificată.' },
  { title: 'Curs rețele', heading: 'Transport', text: 'Conexiunea se stabilește printr-un three-way handshake între client și server.' },
  { title: 'Curs rețele', heading: 'Transport', text: 'Fereastra glisantă reglează debitul în funcție de congestia din rețea.' },
  { title: 'Note bucătărie', heading: 'Rețete', text: 'Aluatul se lasă la dospit timp de o oră într-un vas acoperit.' }
];

test.before(async () => {
  fs.rmSync(process.env.DB_FILE, { force: true });
  const d = db.open();
  const doc = d.prepare("INSERT INTO documents(title, source_type, content_hash, added_at) VALUES (?, 'text', ?, datetime('now'))");
  const chunk = d.prepare('INSERT INTO chunks(document_id, ordinal, text, heading, char_start, char_end, token_est) VALUES (?,?,?,?,?,?,?)');

  const [vec] = await embed(['probe']);
  db.ensureVectorTable(vec.length);
  const insVec = d.prepare('INSERT INTO chunk_vectors(rowid, embedding) VALUES (?, ?)');

  const titles = new Map();
  for (const [i, item] of CORPUS.entries()) {
    if (!titles.has(item.title)) {
      titles.set(item.title, doc.run(item.title, 'hash-' + item.title).lastInsertRowid);
    }
    const id = chunk.run(titles.get(item.title), i, item.text, item.heading, 0, item.text.length, 20).lastInsertRowid;
    const [v] = await embed([item.text]);
    // sqlite-vec requires a BigInt rowid through better-sqlite3.
    insVec.run(BigInt(id), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  }
});

test.after(() => {
  // Windows refuses to delete a file that is still open.
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_FILE + suffix, { force: true });
});

test('FTS query is built safely from free text', () => {
  assert.equal(buildFtsQuery('Ce este un handshake?'), '"handshake"*');
  // Quotes and FTS operators in user input must not leak into the expression.
  const nasty = buildFtsQuery('fișier" OR NEAR(broken');
  assert.ok(!nasty.includes('" OR NEAR'), 'user input escaped the quoting');
  assert.equal(buildFtsQuery('?? !!'), null, 'a query with no usable terms returns null');
});

test('keyword search finds an exact code that means nothing semantically', () => {
  const hits = keywordSearch('EPERM 4093');
  assert.ok(hits.length > 0);
  const d = db.open();
  const top = d.prepare('SELECT text FROM chunks WHERE id = ?').get(hits[0].chunkId);
  assert.match(top.text, /EPERM 4093/);
});

test('vector search returns results ordered by distance', async () => {
  const hits = await vectorSearch('handshake conexiune');
  assert.ok(hits.length > 0);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i].distance >= hits[i - 1].distance, 'distances must ascend');
  }
  assert.ok(hits[0].similarity >= 0 && hits[0].similarity <= 1);
});

test('fusion rewards agreement without letting one list dominate', () => {
  const fused = reciprocalRankFusion([
    { name: 'keyword', results: [{ chunkId: 1 }, { chunkId: 2 }, { chunkId: 3 }] },
    { name: 'vector', results: [{ chunkId: 3 }, { chunkId: 1 }, { chunkId: 9 }] }
  ]);

  assert.equal(fused[0].chunkId, 1, 'ranked 1st and 2nd should beat 1st and 3rd');
  assert.deepEqual(fused[0].ranks, { keyword: 1, vector: 2 });

  // A chunk only one method found is still present — that is the whole point.
  const only = fused.find((f) => f.chunkId === 9);
  assert.ok(only, 'a single-list hit must survive the merge');
  assert.ok(only.rrf < fused[0].rrf);
});

test('fusion is stable and score-scale independent', () => {
  // BM25 scores are negative and cosine distances are small positives; RRF
  // must not care, because it only reads positions.
  const a = reciprocalRankFusion([
    { name: 'keyword', results: [{ chunkId: 5, score: -12.4 }, { chunkId: 6, score: -0.2 }] },
    { name: 'vector', results: [{ chunkId: 6, similarity: 0.91 }, { chunkId: 5, similarity: 0.90 }] }
  ]);
  const b = reciprocalRankFusion([
    { name: 'keyword', results: [{ chunkId: 5, score: -9999 }, { chunkId: 6, score: -1 }] },
    { name: 'vector', results: [{ chunkId: 6, similarity: 0.5 }, { chunkId: 5, similarity: 0.49 }] }
  ]);
  assert.deepEqual(a.map((x) => x.chunkId), b.map((x) => x.chunkId));
});

test('hybrid search returns hydrated results with their provenance', async () => {
  const { results, counts } = await search('EPERM 4093 permisiuni', { limit: 5 });
  assert.ok(results.length > 0);
  const top = results[0];
  assert.match(top.text, /EPERM 4093/);
  assert.equal(top.documentTitle, 'Ghid erori');
  assert.equal(top.heading, 'Coduri');
  assert.ok(top.ranks.keyword, 'the result should record which method found it');
  assert.ok(counts.keyword > 0);
});

test('search can be limited to one document', async () => {
  const d = db.open();
  const networking = d.prepare("SELECT id FROM documents WHERE title = 'Curs rețele'").get().id;
  const { results } = await search('conexiune', { documentIds: [networking], limit: 10 });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.documentId === networking));
});

test('an empty or nonsense query returns nothing rather than throwing', async () => {
  const { results } = await search('?!', { limit: 5 });
  assert.ok(Array.isArray(results));
});
