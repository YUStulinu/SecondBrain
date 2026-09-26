/**
 * The citation checker is what separates "the documents were in the prompt"
 * from "this claim is backed by that sentence". These tests feed it a reply
 * containing deliberate faults and check each one is caught.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { verify, buildContext } = require('../lib/answer');
const { extractHtml, extractionWarnings } = require('../lib/extract');

const used = [
  {
    label: 'S1', chunkId: 11, documentId: 1, documentTitle: 'Curs rețele', heading: 'Transport', page: 4, ordinal: 0,
    text: 'Conexiunea TCP se stabilește printr-un three-way handshake: SYN, SYN-ACK, ACK.'
  },
  {
    label: 'S2', chunkId: 12, documentId: 1, documentTitle: 'Curs rețele', heading: 'Transport', page: 5, ordinal: 1,
    text: 'Fereastra glisantă reglează debitul în funcție de congestia din rețea.'
  }
];

test('keeps citations whose quotes really appear in the source', () => {
  const result = verify({
    answer: 'Conexiunea se deschide cu un handshake în trei pași [S1].',
    citations: [{ marker: 'S1', quote: 'se stabilește printr-un three-way handshake' }],
    confidence: 'high'
  }, used);

  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].chunkId, 11);
  assert.equal(result.citations[0].page, 4);
  assert.equal(result.verification.dropped.length, 0);
  assert.match(result.answer, /\[S1\]/);
});

test('drops an invented quote and marks the claim unverified', () => {
  const result = verify({
    answer: 'TCP criptează datele cu AES-256 [S1].',
    citations: [{ marker: 'S1', quote: 'TCP criptează datele folosind AES-256' }],
    confidence: 'high'
  }, used);

  assert.equal(result.citations.length, 0, 'the fabricated quote must not survive');
  assert.equal(result.verification.dropped[0].reason, 'the quote does not appear in that source');
  assert.match(result.answer, /\[unverified\]/);
  assert.ok(!/\[S1\]/.test(result.answer), 'the dead marker must be replaced');
});

test('drops a citation pointing at a source that was never retrieved', () => {
  const result = verify({
    answer: 'Ceva despre rutare [S9].',
    citations: [{ marker: 'S9', quote: 'orice text' }],
    confidence: 'high'
  }, used);

  assert.equal(result.citations.length, 0);
  assert.equal(result.verification.dropped[0].reason, 'cites a source that was not retrieved');
});

test('ignores diacritics and small punctuation differences in a quote', () => {
  const result = verify({
    answer: 'Debitul este reglat de fereastra glisantă [S2].',
    citations: [{ marker: 'S2', quote: 'Fereastra glisanta regleaza debitul' }],
    confidence: 'high'
  }, used);
  assert.equal(result.citations.length, 1, 'a real quote written without diacritics is still real');
});

test('an answer left with no verified citation cannot stay "high" confidence', () => {
  const result = verify({
    answer: 'Afirmație fără sursă [S1].',
    citations: [{ marker: 'S1', quote: 'text care nu există nicăieri în sursă' }],
    confidence: 'high'
  }, used);
  assert.equal(result.confidence, 'partial');
});

test('"not in the documents" is preserved as a valid answer', () => {
  const result = verify({
    answer: 'Documentele tale nu acoperă acest subiect.',
    citations: [],
    confidence: 'none',
    missing: 'Nimic despre rutarea BGP.'
  }, used);

  assert.equal(result.confidence, 'none');
  assert.equal(result.citations.length, 0);
  assert.equal(result.missing, 'Nimic despre rutarea BGP.');
});

test('context packing stops at the token budget and labels sources in order', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    chunkId: i, documentId: 1, documentTitle: 'Doc', heading: 'H', page: 1, ordinal: i,
    text: 'cuvânt '.repeat(300)
  }));
  const { used: packed, context, tokens } = buildContext(many, 2000);

  assert.ok(packed.length < many.length, 'the budget must actually limit the context');
  assert.ok(tokens <= 2400);
  assert.equal(packed[0].label, 'S1');
  assert.match(context, /<source id="S1"/);
});

test('HTML extraction keeps headings and drops scripts', () => {
  const text = extractHtml(`
    <html><head><style>p{color:red}</style><script>alert(1)</script></head>
    <body><h1>Titlu principal</h1><p>Primul paragraf.</p>
    <ul><li>element unu</li><li>element doi</li></ul>
    <p>Al doilea &amp; ultimul.</p></body></html>`);

  assert.match(text, /# Titlu principal/);
  assert.match(text, /Primul paragraf\./);
  assert.match(text, /- element unu/);
  assert.match(text, /Al doilea & ultimul/, 'entities should be decoded');
  assert.ok(!/alert\(1\)/.test(text), 'scripts must be stripped');
  assert.ok(!/color:red/.test(text), 'styles must be stripped');
});

test('a scanned document is reported rather than indexed as empty', () => {
  assert.ok(extractionWarnings({ text: 'doar cateva cuvinte aici', pageCount: 40 }).length > 0);
  assert.equal(extractionWarnings({ text: 'cuvânt '.repeat(500), pageCount: 2 }).length, 0);
});
