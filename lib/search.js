/**
 * search.js — finding the right chunks.
 *
 * Pure vector search is the thing everyone builds first, and it quietly
 * fails on exactly the queries people actually type. Ask for an error code,
 * a person's name, "art. 1350", a library version — and the embedding of a
 * rare literal token barely differs from the embedding of its neighbours,
 * so the right chunk ranks tenth. Meanwhile keyword search nails those and
 * fails completely on "how do I stop the connection dropping", where none
 * of the words in the answer appear in the question.
 *
 * So both run, and the two ranked lists are merged.
 *
 * The merge uses Reciprocal Rank Fusion. The tempting alternative is to
 * normalize the two scores and add them, but BM25 scores and cosine
 * distances live on unrelated scales that shift with every query — a BM25
 * of 9 means something different for a one-word query than a ten-word one.
 * RRF throws the scores away and keeps only the positions:
 *
 *     score(chunk) = Σ  1 / (K + rank_in_that_list)
 *
 * A chunk that both methods rank highly wins. A chunk one method loves and
 * the other has never heard of still places well, which is the point: it
 * rescues the exact-match hits that vectors miss, and the paraphrase hits
 * that keywords miss, without either list being able to dominate.
 */
const db = require('./db');
const { embed } = require('./embed');
const { queryTerms, normalize } = require('./text');

const RRF_K = 60;          // the standard damping constant from the RRF paper
const CANDIDATES = 40;     // how deep each method looks before merging

/* ---------------- keyword side ---------------- */

/**
 * Builds an FTS5 query from free text.
 *
 * User input goes nowhere near the MATCH expression directly: FTS5 has its
 * own syntax, so a stray quote or a bare "AND" would either error or change
 * the meaning. Every term is quoted, and a prefix wildcard is added so
 * "handshak" still finds "handshake".
 */
function buildFtsQuery(question) {
  const terms = queryTerms(question);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

function keywordSearch(question, limit = CANDIDATES) {
  const match = buildFtsQuery(question);
  if (!match) return [];
  const d = db.open();

  try {
    // bm25() returns a negative number where more negative is better, so
    // ascending order puts the best match first.
    return d.prepare(`
      SELECT c.id AS chunkId, bm25(chunks_fts, 1.0, 0.6) AS score
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(match, limit);
  } catch (err) {
    // A malformed MATCH should degrade to "no keyword hits", not break search.
    console.error('FTS query failed:', err.message, '| match was:', match);
    return [];
  }
}

/* ---------------- vector side ---------------- */

async function vectorSearch(question, limit = CANDIDATES) {
  if (!db.hasVectorTable()) return [];
  const d = db.open();

  const [vec] = await embed([question], { kind: 'query' });
  const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

  const rows = d.prepare(`
    SELECT rowid AS chunkId, distance
    FROM chunk_vectors
    WHERE embedding MATCH ? AND k = ?
    ORDER BY distance
  `).all(blob, limit);

  // Vectors are unit length, so L2 distance maps back to cosine similarity
  // as  cos = 1 - d²/2.  Only used for display; ranking uses the order.
  return rows.map((r) => ({
    chunkId: Number(r.chunkId),
    distance: r.distance,
    similarity: Math.max(0, 1 - (r.distance * r.distance) / 2)
  }));
}

/* ---------------- fusion ---------------- */

function reciprocalRankFusion(lists, { k = RRF_K } = {}) {
  const scores = new Map();

  for (const { name, results, weight = 1 } of lists) {
    results.forEach((row, index) => {
      const id = row.chunkId;
      const entry = scores.get(id) || { chunkId: id, rrf: 0, ranks: {}, detail: {} };
      entry.rrf += weight * (1 / (k + index + 1));
      entry.ranks[name] = index + 1;
      if (row.similarity !== undefined) entry.detail.similarity = row.similarity;
      if (row.score !== undefined) entry.detail.bm25 = row.score;
      scores.set(id, entry);
    });
  }

  return [...scores.values()].sort((a, b) => b.rrf - a.rrf);
}

/* ---------------- public search ---------------- */

/**
 * search(question, options) -> { results, timings, counts }
 *
 * `results` are hydrated chunks in fused order, each carrying its document
 * and the ranks it earned in each method — which is what lets the UI show
 * *why* something was retrieved.
 */
async function search(question, {
  limit = 8,
  candidates = CANDIDATES,
  mode = 'hybrid',          // 'hybrid' | 'vector' | 'keyword'
  collection = null,
  documentIds = null
} = {}) {
  const d = db.open();
  const timings = {};

  let keyword = [];
  let vector = [];

  if (mode !== 'vector') {
    const t = Date.now();
    keyword = keywordSearch(question, candidates);
    timings.keyword = Date.now() - t;
  }
  if (mode !== 'keyword') {
    const t = Date.now();
    try {
      vector = await vectorSearch(question, candidates);
    } catch (err) {
      // Search should still work if the embedding provider is unavailable.
      console.error('Vector search unavailable:', err.message);
      timings.vectorError = err.message;
    }
    timings.vector = Date.now() - t;
  }

  const fused = reciprocalRankFusion([
    { name: 'keyword', results: keyword },
    { name: 'vector', results: vector }
  ]);

  if (!fused.length) {
    return { results: [], timings, counts: { keyword: keyword.length, vector: vector.length } };
  }

  // Hydrate in one query rather than one per chunk.
  const ids = fused.map((f) => f.chunkId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT c.id, c.document_id, c.ordinal, c.text, c.heading, c.page,
           c.char_start, c.char_end,
           doc.title, doc.filename, doc.collection, doc.source_type
    FROM chunks c
    JOIN documents doc ON doc.id = c.document_id
    WHERE c.id IN (${placeholders})
  `).all(...ids);

  const byId = new Map(rows.map((r) => [r.id, r]));

  let results = fused
    .map((f) => {
      const row = byId.get(f.chunkId);
      if (!row) return null;
      return {
        chunkId: row.id,
        documentId: row.document_id,
        documentTitle: row.title,
        filename: row.filename,
        collection: row.collection,
        ordinal: row.ordinal,
        heading: row.heading,
        page: row.page,
        text: row.text,
        charStart: row.char_start,
        charEnd: row.char_end,
        rrf: f.rrf,
        ranks: f.ranks,
        similarity: f.detail.similarity ?? null,
        bm25: f.detail.bm25 ?? null
      };
    })
    .filter(Boolean);

  if (collection) results = results.filter((r) => r.collection === collection);
  if (documentIds?.length) {
    const allowed = new Set(documentIds.map(Number));
    results = results.filter((r) => allowed.has(r.documentId));
  }

  return {
    results: results.slice(0, limit),
    timings,
    counts: { keyword: keyword.length, vector: vector.length, fused: results.length }
  };
}

/**
 * Pulls the chunks either side of a hit, so an answer can quote a passage
 * that runs over a chunk boundary and the UI can show context around it.
 */
function neighbours(chunkId, span = 1) {
  const d = db.open();
  const chunk = d.prepare('SELECT document_id, ordinal FROM chunks WHERE id = ?').get(chunkId);
  if (!chunk) return [];
  return d.prepare(`
    SELECT id, ordinal, text, heading, page
    FROM chunks
    WHERE document_id = ? AND ordinal BETWEEN ? AND ?
    ORDER BY ordinal
  `).all(chunk.document_id, chunk.ordinal - span, chunk.ordinal + span);
}

module.exports = { search, keywordSearch, vectorSearch, reciprocalRankFusion, buildFtsQuery, neighbours, RRF_K };
