/**
 * The command line an AI agent uses: index a note, find a passage, and check an answer that has
 * one true citation, one invented quote and one passage id that does not exist.
 * Runs with the offline hash embeddings and a throwaway database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'brain.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cli-'));
const env = { ...process.env, EMBEDDING_PROVIDER: 'hash', DB_FILE: path.join(dir, 'brain.db') };

function brain(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('add, search, show and check from the command line', () => {
  const note = path.join(dir, 'tcp.md');
  fs.writeFileSync(note, '# Transport\n\n## Handshake\n\nA TCP connection is opened with a three-way handshake: SYN, SYN-ACK, ACK. ' +
    'The sliding window then regulates the sending rate according to network congestion.\n');

  const added = brain('add', note, '--collection', 'networks');
  assert.equal(added.code, 0, added.err);
  assert.equal(added.out[0].status, 'ready');
  assert.ok(added.out[0].passages >= 1);
  assert.equal(brain('add', note).out[0].duplicate, true);

  const found = brain('search', 'three-way handshake SYN');
  assert.equal(found.code, 0, found.err);
  const hit = found.out.results[0];
  assert.match(hit.text, /three-way handshake/);
  assert.ok(hit.ranks.keyword, 'the keyword search found it');

  const shown = brain('show', String(hit.id));
  assert.equal(shown.out.passage.id, hit.id);

  const answer = path.join(dir, 'answer.json');
  fs.writeFileSync(answer, JSON.stringify({
    answer: 'TCP opens a connection with a three-way handshake [S1]. It encrypts data with AES-256 [S2]. It uses QUIC [S3].',
    citations: [
      { marker: 'S1', passageId: hit.id, quote: 'opened with a three-way handshake: SYN, SYN-ACK, ACK' },
      { marker: 'S2', passageId: hit.id, quote: 'TCP encrypts every segment with AES-256' },
      { marker: 'S3', passageId: 99999, quote: 'TCP is replaced by QUIC everywhere' }
    ],
    confidence: 'high'
  }));
  const checked = brain('check', answer);
  assert.equal(checked.code, 0, checked.err);
  assert.equal(checked.out.citations.length, 1);
  assert.equal(checked.out.citations[0].chunkId, hit.id);
  const reasons = checked.out.verification.dropped.map((x) => x.reason).sort();
  assert.deepEqual(reasons, ['no passage with id 99999', 'the quote does not appear in that source']);
  assert.match(checked.out.answer, /handshake \[S1\]\. It encrypts data with AES-256 \[unverified\]\. It uses QUIC \[unverified\]/);
  assert.equal(checked.out.confidence, 'partial');

  assert.equal(brain('list').out.length, 1);
  assert.equal(brain('search').code, 2);
});
