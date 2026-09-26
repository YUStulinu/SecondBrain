#!/usr/bin/env node
/**
 * reindex.js — rebuilds every vector from the text already stored.
 *
 * Needed whenever EMBEDDING_MODEL changes. Two models place text in two
 * different spaces, so their vectors cannot be compared; mixing them does
 * not throw an error, it just quietly returns bad results. Rebuilding is
 * the only correct response, and because the extracted text is kept, it
 * runs locally without touching the original files.
 */
require('dotenv').config();
const db = require('../lib/db');
const { reindexDocument, events } = require('../lib/ingest');
const { currentConfig } = require('../lib/embed');

(async () => {
  const d = db.open();
  const docs = d.prepare('SELECT id, title, extracted_text IS NOT NULL AS has_text FROM documents ORDER BY id').all();

  if (!docs.length) {
    console.log('Nothing to reindex — the library is empty.');
    process.exit(0);
  }

  const { provider, model } = currentConfig();
  const stored = db.getEmbeddingConfig();
  const missing = docs.filter((x) => !x.has_text);

  console.log(`\nReindexing ${docs.length} document(s)`);
  if (stored) console.log(`  from: ${stored.model} (${stored.dims} dimensions)`);
  console.log(`  to:   ${model} (${provider})\n`);

  if (missing.length) {
    console.log(`${missing.length} document(s) were added before the text was kept and will need uploading again:`);
    missing.forEach((m) => console.log(`  - ${m.title}`));
    console.log('');
  }

  // Drop the old vectors and the recorded configuration, so the table is
  // recreated at the new width.
  db.clearIndex();

  events.on('progress', (p) => {
    if (p.stage === 'embedding' && p.chunksDone) {
      process.stdout.write(`\r  embedding ${p.chunksDone}/${p.chunks}   `);
    }
  });

  let done = 0;
  let failed = 0;

  for (const doc of docs) {
    if (!doc.has_text) { failed++; continue; }
    process.stdout.write(`\n[${done + failed + 1}/${docs.length}] ${doc.title}\n`);
    try {
      const result = await reindexDocument(doc.id);
      console.log(`\r  ${result.chunks} passages indexed          `);
      done++;
    } catch (err) {
      console.error(`\r  failed: ${err.message}`);
      failed++;
    }
  }

  const stats = db.stats();
  console.log(`\nDone. ${done} document(s) reindexed, ${stats.chunks} passages, ${stats.vectors} vectors.`);
  if (failed) console.log(`${failed} document(s) could not be rebuilt and should be re-added.`);
  process.exit(0);
})();
