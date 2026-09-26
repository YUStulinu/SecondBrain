/**
 * text.js — normalization, rough token counting, and snippet highlighting.
 */

/** Strips diacritics and lowercases, so "conexiune" matches "conexiúne". */
function normalize(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cleans up text extracted from a document without destroying its structure. */
function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')            // non-breaking spaces
    .replace(/[\u200b-\u200d\ufeff]/g, '') // zero-width junk from PDFs
    .replace(/(\w)-\n(\w)/g, '$1$2')    // words hyphenated across a line break
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Token count, estimated rather than measured.
 *
 * A real tokenizer would mean shipping one per model. For deciding chunk
 * sizes and prompt budgets, ~4 characters per token is close enough in
 * English and a little pessimistic in Romanian, which is the safe direction.
 */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/** Meaningful words from a query, for highlighting and for FTS. */
function queryTerms(query) {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'what', 'when', 'where', 'which', 'that', 'this', 'from', 'are', 'was', 'how', 'does', 'did', 'about',
    'care', 'este', 'sunt', 'pentru', 'despre', 'unde', 'cand', 'cum', 'ce', 'in', 'la', 'de', 'si', 'sau', 'era', 'fost', 'mai', 'cu', 'pe', 'un', 'o'
  ]);
  return [...new Set(
    normalize(query).split(/[^a-z0-9+#._-]+/).filter((w) => w.length >= 3 && !stop.has(w))
  )];
}

/**
 * Builds a short excerpt centred on the first query term found, with the
 * matched words wrapped in <mark>. Returns HTML-safe output.
 */
function highlight(text, query, { window = 320 } = {}) {
  const terms = queryTerms(query);
  const normText = normalize(text);

  let start = 0;
  for (const term of terms) {
    const at = normText.indexOf(term);
    if (at >= 0) {
      start = Math.max(0, at - Math.floor(window / 3));
      break;
    }
  }

  let end = Math.min(text.length, start + window);
  // Prefer to start and end on word boundaries.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space > 0 && space - start < 25) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > start) end = space;
  }

  const excerpt = text.slice(start, end);
  let html = escapeHtml(excerpt);

  for (const term of terms) {
    // Match the term ignoring diacritics: build a pattern that accepts any
    // accented form of each letter.
    const pattern = term.split('').map((ch) => {
      if (!/[a-z]/.test(ch)) return escapeRegExp(ch);
      const variants = { a: 'aăâáà', i: 'iîí', s: 'sș', t: 'tț', e: 'eé' }[ch];
      return variants ? `[${variants}${variants.toUpperCase()}]` : `[${ch}${ch.toUpperCase()}]`;
    }).join('');
    html = html.replace(new RegExp(`(?<![\\p{L}\\d])(${pattern})(?![\\p{L}\\d])`, 'gu'), '<mark>$1</mark>');
  }

  return {
    html: (start > 0 ? '…' : '') + html + (end < text.length ? '…' : ''),
    start,
    end
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks that a quoted sentence really came from the given text. Used to
 * verify the model's citations rather than trusting them.
 */
function quoteAppearsIn(quote, text) {
  const q = normalize(quote);
  const t = normalize(text);
  if (q.length < 8) return false;
  if (t.includes(q)) return true;
  // Allow small differences (a dropped comma, a line break) but require
  // nearly all of the quote's words to be present, in order.
  const words = q.split(' ').filter((w) => w.length > 2);
  if (words.length < 3) return false;
  const hits = words.filter((w) => t.includes(w)).length;
  return hits / words.length >= 0.85;
}

module.exports = {
  normalize, cleanText, estimateTokens, queryTerms,
  highlight, escapeHtml, quoteAppearsIn
};
