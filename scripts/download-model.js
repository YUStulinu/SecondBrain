#!/usr/bin/env node
/**
 * Downloads the local embedding model once, with visible progress, so the
 * first document you add is not silently blocked on a 120 MB download.
 */
require('dotenv').config();
const { currentConfig, embed } = require('../lib/embed');

(async () => {
  const { provider, model } = currentConfig();
  if (provider !== 'local') {
    console.log(`EMBEDDING_PROVIDER is "${provider}", so no local model is needed.`);
    process.exit(0);
  }

  console.log(`Downloading ${model} (about 120 MB the first time)…`);
  const seen = new Set();

  try {
    await embed(['warm up'], {
      kind: 'query',
      onProgress: ({ file, percent }) => {
        const key = `${file}:${Math.floor(percent / 25)}`;
        if (seen.has(key)) return;
        seen.add(key);
        process.stdout.write(`  ${file} ${percent}%\n`);
      }
    });
    console.log('\nModel ready. It is cached in ./models, so this only happens once.');
    console.log('Check everything with: npm run doctor');
  } catch (err) {
    console.error('\nDownload failed:\n' + err.message);
    process.exit(1);
  }
})();
