// Tests for text normalisation, highlighting, quote checks and file extraction (PDF reflow, file types).
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, cleanText, estimateTokens, queryTerms, highlight, quoteAppearsIn } = require('../lib/text');
const { extract, reflowLines } = require('../lib/extract');

test('normalize strips diacritics, case and extra spaces', () => {
  assert.equal(normalize('  Conexiúne   ȘI  Țară\n'), 'conexiune si tara');
  assert.equal(normalize(null), '');
});

test('cleanText fixes line endings, hyphenation, zero-width junk and blank runs', () => {
  assert.equal(cleanText('Infor-\r\nmation​ here now  \t\n\n\n\nNext  '), 'Information here now\n\nNext');
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens(''), 0);
});

test('query terms drop English and Romanian stop words, short words and duplicates', () => {
  assert.deepEqual(queryTerms('What is the C++ API for the Node.js API?'), ['c++', 'api', 'node.js']);
  assert.deepEqual(queryTerms('Care este rețeta pentru sarmale și cum se face'), ['reteta', 'sarmale', 'face']);
});

test('highlight marks accented forms of the terms and escapes HTML', () => {
  const { html } = highlight('Rețeta <b>bună</b> pentru sarmale: varză și carne.', 'reteta varza');
  assert.equal(html, '<mark>Rețeta</mark> &lt;b&gt;bună&lt;/b&gt; pentru sarmale: <mark>varză</mark> și carne.');
});

test('highlight centres the excerpt on the first matching term with ellipses', () => {
  const text = 'filler '.repeat(200) + 'The quarterly revenue grew by four percent. ' + 'tail '.repeat(200);
  const { html, start, end } = highlight(text, 'revenue', { window: 120 });
  assert.ok(start > 0 && end < text.length);
  assert.ok(html.startsWith('…') && html.endsWith('…'));
  assert.match(html, /<mark>revenue<\/mark>/);
});

test('a quote counts only if it is in the text or nearly all its words are', () => {
  const source = 'The committee approved the new budget on Friday, after a long debate.';
  assert.ok(quoteAppearsIn('approved the new budget on Friday', source));
  assert.ok(quoteAppearsIn('The committee approved the new budget on Friday after a long debate', source));
  assert.ok(!quoteAppearsIn('The board rejected the budget', source));
  assert.ok(!quoteAppearsIn('budget', source), 'too short to trust');
});

test('PDF reflow joins wrapped sentences and keeps headings and list items apart', () => {
  // PDF lines are wrapped at the page width, so a sentence continues on a lowercase line.
  const pdf = [
    '3.1 Method',
    'This project builds a small search engine over your own documents and then',
    'answers questions with quotes that can be checked against the source.',
    'Results',
    '- first item',
    '2) second item',
    'The method works well in practice because the chunker in this project',
    'respects the structure of every document it reads.',
  ].join('\n');
  assert.equal(reflowLines(pdf), [
    '## 3.1 Method',
    'This project builds a small search engine over your own documents and then answers questions with quotes ' +
      'that can be checked against the source.',
    '## Results',
    '- first item',
    '2) second item',
    'The method works well in practice because the chunker in this project respects the structure of every ' +
      'document it reads.',
  ].join('\n\n'));
  assert.equal(reflowLines('# Already markdown'), '# Already markdown');
});

test('text-like files are read and cleaned; .doc and unknown types are refused', async () => {
  const md = await extract(Buffer.from('# Notes\r\n\r\n\r\n\r\nBody'), 'notes.MD');
  assert.deepEqual(md, { text: '# Notes\n\nBody', pages: null });
  const html = await extract(Buffer.from('<h1>Title</h1><script>evil()</script><p>Hi &amp; bye</p>'), 'page.htm');
  assert.match(html.text, /Title/);
  assert.match(html.text, /Hi & bye/);
  assert.doesNotMatch(html.text, /evil/);
  await assert.rejects(extract(Buffer.from('x'), 'old.doc'), { status: 400 });
  await assert.rejects(extract(Buffer.from('x'), 'image.png'), { status: 400, message: /Unsupported file type ".png"/ });
  await assert.rejects(extract(Buffer.from('x'), 'noext'), { status: 400, message: /"unknown"/ });
});
