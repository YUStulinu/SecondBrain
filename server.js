require('dotenv').config();

const express = require('express');
const path = require('path');
const multer = require('multer');

const db = require('./lib/db');
const ingest = require('./lib/ingest');
const { search, neighbours } = require('./lib/search');
const answerLib = require('./lib/answer');
const { currentConfig } = require('./lib/embed');
const { highlight } = require('./lib/text');
const { SUPPORTED } = require('./lib/extract');

const app = express();
const PORT = process.env.PORT || 3007;
const HOST = process.env.HOST || '127.0.0.1';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const route = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (!err.status || err.status >= 500) console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error.' });
  });

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const missing = (m) => Object.assign(new Error(m), { status: 404 });

/* ---------------- status ---------------- */

app.get('/api/status', route(async (req, res) => {
  const { provider, model } = currentConfig();
  res.json({
    ...db.stats(),
    embeddingSetting: { provider, model },
    answering: answerLib.hasApiKey(),
    queue: ingest.queueState(),
    supported: SUPPORTED
  });
}));

/* ---------------- documents ---------------- */

app.get('/api/documents', route(async (req, res) => {
  const d = db.open();
  const rows = d.prepare(`
    SELECT doc.*, (SELECT COUNT(*) FROM chunks WHERE document_id = doc.id) AS chunk_count
    FROM documents doc
    ORDER BY doc.added_at DESC
  `).all();

  res.json({
    documents: rows.map((r) => ({
      id: r.id,
      title: r.title,
      filename: r.filename,
      collection: r.collection,
      sourceType: r.source_type,
      byteSize: r.byte_size,
      charCount: r.char_count,
      pageCount: r.page_count,
      chunkCount: r.chunk_count,
      status: r.status,
      note: r.error,
      addedAt: r.added_at,
      indexedAt: r.indexed_at
    })),
    collections: [...new Set(rows.map((r) => r.collection).filter(Boolean))].sort()
  });
}));

app.post('/api/documents/upload', upload.array('files', 20), route(async (req, res) => {
  if (!req.files?.length) throw bad('No files were uploaded.');
  const collection = String(req.body.collection || '').slice(0, 80);

  const added = req.files.map((file) => {
    try {
      // Reject an unusable type here rather than queueing it and letting
      // extraction fail, which would leave a dead "failed" row behind.
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!SUPPORTED.includes(ext)) {
        throw new Error(`"${ext || 'no extension'}" is not a supported type. Supported: ${SUPPORTED.join(', ')}.`);
      }
      const result = ingest.addDocument({
        buffer: file.buffer,
        filename: file.originalname,
        title: file.originalname.replace(/\.[^.]+$/, ''),
        mime: file.mimetype,
        collection
      });
      return { filename: file.originalname, ...result };
    } catch (err) {
      return { filename: file.originalname, error: err.message };
    }
  });

  res.status(201).json({ added });
}));

app.post('/api/documents/text', route(async (req, res) => {
  const text = String(req.body.text || '').trim();
  const title = String(req.body.title || '').trim();
  if (text.length < 20) throw bad('Paste a bit more text — there is not enough here to index.');
  if (!title) throw bad('Give this note a title.');

  const result = ingest.addDocument({
    buffer: Buffer.from(text, 'utf8'),
    filename: `${title}.md`,
    title,
    sourceType: 'text',
    mime: 'text/markdown',
    collection: String(req.body.collection || '').slice(0, 80)
  });
  res.status(201).json(result);
}));

app.get('/api/documents/:id', route(async (req, res) => {
  const d = db.open();
  const doc = d.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) throw missing('Document not found.');
  const chunks = d.prepare('SELECT id, ordinal, heading, page, text, token_est FROM chunks WHERE document_id = ? ORDER BY ordinal').all(doc.id);
  res.json({ document: doc, chunks });
}));

app.delete('/api/documents/:id', route(async (req, res) => {
  if (!ingest.deleteDocument(Number(req.params.id))) throw missing('Document not found.');
  res.json({ ok: true });
}));

/* ---------------- live progress (SSE) ---------------- */

/**
 * Server-Sent Events rather than WebSockets: progress only travels one way,
 * the browser reconnects on its own, and it is plain HTTP so nothing extra
 * is needed in front of it.
 */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify(ingest.queueState())}\n\n`);

  const onProgress = (payload) => {
    res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  ingest.events.on('progress', onProgress);

  // Proxies and browsers drop an idle connection; a comment keeps it warm.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    ingest.events.off('progress', onProgress);
  });
});

/* ---------------- search ---------------- */

app.post('/api/search', route(async (req, res) => {
  const question = String(req.body.q || '').trim();
  if (!question) throw bad('Type something to search for.');

  const started = Date.now();
  const { results, timings, counts } = await search(question, {
    limit: Math.min(Number(req.body.limit) || 10, 30),
    mode: ['hybrid', 'vector', 'keyword'].includes(req.body.mode) ? req.body.mode : 'hybrid',
    collection: req.body.collection || null,
    documentIds: req.body.documentIds || null
  });

  res.json({
    results: results.map((r) => ({ ...r, excerpt: highlight(r.text, question).html })),
    timings: { ...timings, total: Date.now() - started },
    counts
  });
}));

/* ---------------- ask ---------------- */

app.post('/api/ask', route(async (req, res) => {
  const question = String(req.body.q || '').trim();
  if (!question) throw bad('Type a question.');
  if (!db.stats().chunks) throw bad('Your library is empty. Add a document first.');

  const started = Date.now();
  const retrieval = await search(question, {
    limit: Math.min(Number(req.body.topK) || 8, 20),
    mode: 'hybrid',
    collection: req.body.collection || null,
    documentIds: req.body.documentIds || null
  });
  const retrievedMs = Date.now() - started;

  const answered = await answerLib.answerQuestion(question, retrieval.results, {
    language: req.body.language || 'auto'
  });

  // Attach a highlighted excerpt to each citation so the UI can show the
  // quote in context, inside the passage it came from.
  const d = db.open();
  const citations = answered.citations.map((c) => {
    const chunk = d.prepare('SELECT text FROM chunks WHERE id = ?').get(c.chunkId);
    return { ...c, excerpt: chunk ? highlight(chunk.text, c.quote, { window: 400 }).html : '' };
  });

  const stats = {
    retrievedMs,
    totalMs: Date.now() - started,
    retrieved: retrieval.results.length,
    counts: retrieval.counts,
    verification: answered.verification,
    usage: answered.usage
  };

  d.prepare('INSERT INTO queries(question, answer, citations, stats, asked_at) VALUES (?,?,?,?,?)')
    .run(question, answered.answer, JSON.stringify(citations), JSON.stringify(stats), new Date().toISOString());

  res.json({
    question,
    answer: answered.answer,
    confidence: answered.confidence,
    missing: answered.missing,
    citations,
    usedSources: answered.usedSources,
    results: retrieval.results.map((r) => ({ ...r, excerpt: highlight(r.text, question).html })),
    stats
  });
}));

app.get('/api/queries', route(async (req, res) => {
  const rows = db.open().prepare('SELECT id, question, asked_at FROM queries ORDER BY id DESC LIMIT 30').all();
  res.json({ queries: rows });
}));

/* ---------------- chunk inspection ---------------- */

app.get('/api/chunks/:id/context', route(async (req, res) => {
  const span = req.query.span === undefined ? 1 : Math.min(Math.max(Number(req.query.span) || 0, 0), 5);
  const around = neighbours(Number(req.params.id), span);
  if (!around.length) throw missing('Chunk not found.');
  res.json({ chunks: around });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// Clean up anything a previous run left half-finished before serving.
ingest.recoverInterrupted();

app.listen(PORT, HOST, () => {
  const { provider, model } = currentConfig();
  console.log(`Second Brain is running at http://localhost:${PORT}`);
  console.log(`Embeddings: ${provider} (${model})`);
  if (!answerLib.hasApiKey()) {
    console.warn('⚠️  ANTHROPIC_API_KEY is not set — search works, answering does not.');
  }
  if (provider === 'hash') {
    console.warn('⚠️  EMBEDDING_PROVIDER=hash has no semantic understanding. For real use, switch to local or openai.');
  }
});
