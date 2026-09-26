#!/usr/bin/env node
/**
 * doctor.js — checks everything the app needs before you rely on it.
 *
 * The embedding model is the part most likely to be missing or misconfigured,
 * and a wrong model produces quietly poor search rather than an error, so it
 * is actually loaded and run here instead of merely being read from .env.
 */
require('dotenv').config();

const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const warn = (m) => console.log('  \x1b[33m!\x1b[0m ' + m);
const fail = (m) => console.log('  \x1b[31m✗\x1b[0m ' + m);

(async () => {
  let problems = 0;
  console.log('\nSecond Brain — environment check\n');

  // Node ----------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`Node ${process.versions.node}`);
  else { fail(`Node ${process.versions.node} is too old; 18 or newer is required.`); problems++; }

  // Database ------------------------------------------------------------
  try {
    const db = require('../lib/db');
    const stats = db.stats();
    ok(`SQLite opened, schema ready (${stats.documents} documents, ${stats.chunks} passages)`);
    if (db.hasVectorTable()) ok(`sqlite-vec loaded, ${stats.vectors} vectors stored`);
    else warn('No vector index yet — it is created when you add your first document.');
  } catch (err) {
    fail('Database problem: ' + err.message);
    problems++;
  }

  // Embeddings ----------------------------------------------------------
  const { currentConfig, probe, KNOWN_DIMS } = require('../lib/embed');
  const { provider, model } = currentConfig();
  console.log(`\n  Embeddings: ${provider} (${model})`);

  if (provider === 'hash') {
    warn('The "hash" provider matches words, not meaning. Fine for a smoke test, useless for real documents.');
  }

  try {
    const result = await probe();
    ok(`Embedding works — ${result.dims} dimensions, ${result.ms} ms for one short text`);
    if (result.expectedDims && result.expectedDims !== result.dims) {
      warn(`Expected ${result.expectedDims} dimensions for this model but got ${result.dims}. Check EMBEDDING_MODEL.`);
    }
    if (provider === 'local' && result.ms > 4000) {
      warn('That was slow. The first call includes loading the model; later ones should be much faster.');
    }

    const db = require('../lib/db');
    const stored = db.getEmbeddingConfig();
    if (stored && (stored.model !== model || stored.dims !== result.dims)) {
      fail(`The existing index was built with "${stored.model}" (${stored.dims} dims). Vectors from two models cannot be compared — restore that setting or run: npm run reindex`);
      problems++;
    }
  } catch (err) {
    fail('Embeddings are not working:\n      ' + String(err.message).split('\n').join('\n      '));
    problems++;
  }

  // Answering -----------------------------------------------------------
  console.log('');
  if (!process.env.ANTHROPIC_API_KEY) {
    warn('No ANTHROPIC_API_KEY — search works, written answers do not.');
  } else {
    try {
      const res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
        })
      });
      if (res.ok) ok('Anthropic API reachable and the key is accepted');
      else if (res.status === 401) { fail('Anthropic rejected the key. Check ANTHROPIC_API_KEY in .env.'); problems++; }
      else { warn(`Anthropic returned ${res.status}. It may be a temporary problem.`); }
    } catch (err) {
      warn('Could not reach the Anthropic API: ' + err.message);
    }
  }

  console.log(problems
    ? `\n${problems} problem${problems > 1 ? 's' : ''} to fix before this will work properly.\n`
    : '\nEverything checks out. Start it with: npm start\n');
  process.exit(problems ? 1 : 0);
})();
