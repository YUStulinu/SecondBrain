const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkText, embeddableText, splitSentences } = require('../lib/chunk');
const { quoteAppearsIn, highlight, queryTerms } = require('../lib/text');

const doc = `# Nivelul transport

Protocolul TCP este orientat pe conexiune. Înainte de transferul de date se stabilește o conexiune printr-un three-way handshake: clientul trimite SYN, serverul răspunde cu SYN-ACK, iar clientul confirmă cu ACK.

Fereastra glisantă controlează câte segmente pot fi trimise fără confirmare. Dimensiunea ferestrei se ajustează dinamic în funcție de congestie.

# Nivelul rețea

Protocolul IP este fără conexiune și nu garantează livrarea. Fiecare pachet este rutat independent, ceea ce înseamnă că pachetele pot ajunge în altă ordine decât au fost trimise.`;

test('cuts on headings, and every chunk carries its heading', () => {
  const chunks = chunkText(doc);
  assert.ok(chunks.length >= 2, 'expected several chunks');
  for (const c of chunks) {
    assert.ok(c.heading, 'each chunk should know its section');
    assert.ok(c.text.trim().length > 0);
  }
  const headings = [...new Set(chunks.map((c) => c.heading))];
  assert.deepEqual(headings, ['Nivelul transport', 'Nivelul rețea']);
});

test('never mixes two sections into one chunk', () => {
  for (const c of chunkText(doc)) {
    const hasTransport = /three-way handshake|fereastra glisant/i.test(c.text);
    const hasNetwork = /rutat independent/i.test(c.text);
    assert.ok(!(hasTransport && hasNetwork), 'a chunk spans two sections');
  }
});

test('offsets point back into the original text', () => {
  const text = 'Alfa beta gama.\n\nDelta epsilon zeta.\n\nEta theta iota.';
  for (const c of chunkText(text)) {
    assert.ok(c.charStart >= 0 && c.charEnd <= text.length);
    assert.ok(c.charEnd > c.charStart);
  }
});

test('overlaps chunks so an answer across a seam is never cut in half', () => {
  // Many paragraphs in one section, forcing several chunks.
  const paras = [];
  for (let i = 0; i < 12; i++) {
    paras.push(`Paragraful numărul ${i} conține o explicație suficient de lungă încât să umple spațiul disponibil dintr-un chunk obișnuit de text.`);
  }
  const chunks = chunkText('# Secțiune\n\n' + paras.join('\n\n'));
  assert.ok(chunks.length >= 2, 'expected the text to be split');

  let overlapping = 0;
  for (let i = 1; i < chunks.length; i++) {
    const tail = chunks[i - 1].text.slice(-60);
    if (chunks[i].text.includes(tail.trim().slice(0, 30))) overlapping++;
  }
  assert.ok(overlapping >= 1, 'consecutive chunks should share a seam');
});

test('splits a huge paragraph instead of emitting one enormous chunk', () => {
  const long = 'Aceasta este o propoziție de test. '.repeat(200); // ~7000 chars
  const chunks = chunkText(long);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.text.length <= 1500, `chunk too big: ${c.text.length}`);
});

test('keeps page numbers from a page map', () => {
  const text = 'Pagina unu text.\n\nPagina doi text.';
  const pages = [{ page: 1, start: 0, end: 18 }, { page: 2, start: 18, end: text.length }];
  const chunks = chunkText(text, { pages });
  assert.equal(chunks[0].page, 1);
});

test('what gets embedded includes the document and section titles', () => {
  const c = chunkText(doc)[0];
  const emb = embeddableText(c, 'Curs Rețele');
  assert.match(emb, /Curs Rețele/);
  assert.match(emb, /Nivelul transport/);
  assert.ok(emb.endsWith(c.text));
});

test('sentence splitting survives abbreviations and numbers', () => {
  const s = splitSentences('Vezi art. 1350 din cod. Acesta prevede ceva. Nr. 5 este ultimul.');
  assert.ok(s.length <= 3, 'should not break after "art." or "Nr."');
  assert.ok(s.join('').includes('art. 1350'));
});

test('citation checking accepts real quotes and rejects invented ones', () => {
  const chunk = 'Fereastra glisantă controlează câte segmente pot fi trimise fără confirmare.';
  assert.equal(quoteAppearsIn('Fereastra glisantă controlează câte segmente', chunk), true);
  assert.equal(quoteAppearsIn('fereastra glisanta controleaza cate segmente', chunk), true, 'diacritics must not matter');
  assert.equal(quoteAppearsIn('TCP folosește un algoritm de criptare AES', chunk), false);
});

test('highlighting marks the query words, diacritics included', () => {
  const { html } = highlight('Se stabilește o conexiune prin handshake.', 'conexiune handshake');
  assert.match(html, /<mark>conexiune<\/mark>/);
  assert.match(html, /<mark>handshake<\/mark>/);
});

test('query terms drop filler words in both languages', () => {
  const terms = queryTerms('Ce este un three-way handshake în TCP?');
  assert.ok(terms.includes('handshake'));
  assert.ok(terms.includes('tcp'));
  assert.ok(!terms.includes('este'));
  assert.ok(!terms.includes('ce'));
});
