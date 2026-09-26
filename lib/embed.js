/**
 * embed.js — turning text into vectors.
 *
 * Anthropic has no embeddings API, so this is the one part of the system
 * that needs a different provider. Three are supported:
 *
 *   local  — runs an ONNX model on your own machine through transformers.js.
 *            Free, offline after the first download, and your documents
 *            never leave the computer. The default, because a personal
 *            knowledge base is exactly the case where that matters.
 *   openai — text-embedding-3-small. Fast and cheap, but every chunk of
 *            every document is sent to their servers.
 *   hash   — a deterministic local stand-in with no semantic meaning. Used
 *            by the tests, and as a way to try the plumbing without any
 *            model or key.
 *
 * All providers return unit-length vectors. That matters: with normalized
 * vectors, ranking by Euclidean distance (what sqlite-vec does by default)
 * gives exactly the same order as ranking by cosine similarity, so we get
 * cosine behaviour without configuring anything.
 */
const crypto = require('crypto');

const DEFAULTS = {
  local: 'Xenova/multilingual-e5-small',
  openai: 'text-embedding-3-small',
  hash: 'hash-256'
};

/**
 * E5 models were trained with these prefixes and lose accuracy without
 * them: the query and the passage are embedded into slightly different
 * spaces on purpose, which is what makes short questions match long
 * paragraphs well.
 */
function needsE5Prefix(model) {
  return /e5/i.test(model);
}

function applyPrefix(texts, model, kind) {
  if (!needsE5Prefix(model)) return texts;
  const prefix = kind === 'query' ? 'query: ' : 'passage: ';
  return texts.map((t) => prefix + t);
}

function normalizeVector(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/* ================================================================
 * local — transformers.js
 * ================================================================ */

let localPipeline = null;
let localLoading = null;

async function loadLocal(model, onProgress) {
  if (localPipeline) return localPipeline;
  if (localLoading) return localLoading;

  localLoading = (async () => {
    let transformers;
    try {
      // transformers.js ships as ESM only, so a CommonJS project has to
      // reach it through a dynamic import rather than require().
      transformers = await import('@huggingface/transformers');
    } catch (err) {
      throw new Error(
        'The local embedding model needs the transformers.js package.\n' +
        'Run:  npm run setup:local\n' +
        'Or switch to the hosted option by setting EMBEDDING_PROVIDER=openai in .env.\n' +
        `(underlying error: ${err.message})`
      );
    }

    const { pipeline, env } = transformers;
    // Keep model files inside the project instead of a home-directory cache,
    // so they are easy to find and easy to delete.
    env.cacheDir = require('path').join(__dirname, '..', 'models');
    env.allowLocalModels = true;

    try {
      const pipe = await pipeline('feature-extraction', model, {
        dtype: 'q8', // quantized: ~4x smaller and fast enough on a laptop CPU
        progress_callback: (e) => {
          if (onProgress && e && typeof e.progress === 'number') {
            onProgress({ file: e.file, percent: Math.round(e.progress) });
          }
        }
      });
      localPipeline = pipe;
      return pipe;
    } catch (err) {
      throw new Error(
        `Could not load the embedding model "${model}".\n` +
        'The first run downloads roughly 120 MB, so check your connection, ' +
        'and check the model name in .env (EMBEDDING_MODEL).\n' +
        `(underlying error: ${err.message})`
      );
    } finally {
      localLoading = null;
    }
  })();

  return localLoading;
}

async function embedLocal(texts, { model, kind, onProgress }) {
  const pipe = await loadLocal(model, onProgress);
  const prepared = applyPrefix(texts, model, kind);

  const output = await pipe(prepared, { pooling: 'mean', normalize: true });
  const list = output.tolist();          // [[...dims], ...]
  if (typeof output.dispose === 'function') output.dispose();

  return list.map((v) => normalizeVector(Float32Array.from(v)));
}

/* ================================================================
 * openai
 * ================================================================ */

async function embedOpenAI(texts, { model, dimensions }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('EMBEDDING_PROVIDER is "openai" but OPENAI_API_KEY is missing from .env.');
  }

  const body = { model, input: texts };
  if (dimensions) body.dimensions = dimensions;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      const data = await res.json();
      // The API may return results out of order; index says where each belongs.
      const ordered = new Array(texts.length);
      for (const item of data.data) ordered[item.index] = normalizeVector(Float32Array.from(item.embedding));
      return ordered;
    }

    const detail = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 401) throw new Error('OpenAI rejected the API key. Check OPENAI_API_KEY in .env.');
    throw new Error(`OpenAI embeddings failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  throw new Error('OpenAI embeddings are unavailable right now.');
}

/* ================================================================
 * hash — no model, no network, no meaning
 * ================================================================ */

const HASH_DIMS = 256;

/**
 * Hashes word trigrams into a fixed-width vector. Two texts sharing words
 * land near each other, which is enough to exercise the whole pipeline in
 * tests, but it understands nothing: "car" and "automobile" are unrelated.
 * Never use it for real documents.
 */
function embedHash(texts) {
  return texts.map((text) => {
    const vec = new Float32Array(HASH_DIMS);
    const words = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/).filter(Boolean);

    for (let i = 0; i < words.length; i++) {
      for (const gram of [words[i], words.slice(i, i + 2).join(' ')]) {
        const h = crypto.createHash('md5').update(gram).digest();
        const slot = h.readUInt16BE(0) % HASH_DIMS;
        vec[slot] += h[2] % 2 === 0 ? 1 : -1;
      }
    }
    return normalizeVector(vec);
  });
}

/* ================================================================
 * public interface
 * ================================================================ */

function currentConfig() {
  const provider = (process.env.EMBEDDING_PROVIDER || 'local').toLowerCase();
  const model = process.env.EMBEDDING_MODEL || DEFAULTS[provider] || DEFAULTS.local;
  return { provider, model };
}

const KNOWN_DIMS = {
  'Xenova/multilingual-e5-small': 384,
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/multilingual-e5-base': 768,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'hash-256': HASH_DIMS
};

/**
 * embed(texts, { kind }) -> Float32Array[]
 * `kind` is 'passage' when indexing documents and 'query' when searching.
 */
async function embed(texts, { kind = 'passage', onProgress } = {}) {
  if (!texts.length) return [];
  const { provider, model } = currentConfig();

  if (provider === 'hash') return embedHash(texts);
  if (provider === 'openai') return embedOpenAI(texts, { model });
  if (provider === 'local') return embedLocal(texts, { model, kind, onProgress });
  throw new Error(`Unknown EMBEDDING_PROVIDER "${provider}". Use local, openai or hash.`);
}

/**
 * Embeds many texts in batches, reporting progress. Batching keeps memory
 * flat on the local model and stays inside request limits on hosted ones.
 */
async function embedBatched(texts, { kind = 'passage', batchSize, onProgress } = {}) {
  const { provider } = currentConfig();
  const size = batchSize || (provider === 'openai' ? 96 : 16);
  const out = [];

  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    out.push(...await embed(batch, { kind }));
    if (onProgress) onProgress({ done: Math.min(i + size, texts.length), total: texts.length });
  }
  return out;
}

/** Runs one tiny embedding to discover the width and confirm it works. */
async function probe() {
  const { provider, model } = currentConfig();
  const started = Date.now();
  const [vec] = await embed(['test'], { kind: 'query' });
  return {
    provider,
    model,
    dims: vec.length,
    expectedDims: KNOWN_DIMS[model] || null,
    ms: Date.now() - started
  };
}

module.exports = { embed, embedBatched, probe, currentConfig, normalizeVector, KNOWN_DIMS, DEFAULTS };
