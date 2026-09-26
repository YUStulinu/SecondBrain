/**
 * extract.js — getting plain text out of whatever you upload.
 *
 * Beyond the text itself, PDFs also produce a page map: which character
 * range belongs to which page. That is what lets an answer say "page 14"
 * instead of "somewhere in this 200-page file", and it is the difference
 * between a citation you can check and one you have to trust.
 */
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const { cleanText } = require('./text');

const SUPPORTED = ['.pdf', '.docx', '.txt', '.md', '.markdown', '.html', '.htm', '.json', '.csv'];

function userError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function extract(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();

  if (ext === '.pdf') return extractPdf(buffer);
  if (ext === '.docx') return extractDocx(buffer);
  if (ext === '.doc') {
    throw userError('Old .doc files are not supported. Open it and save as .docx or PDF.');
  }
  if (['.html', '.htm'].includes(ext)) return { text: extractHtml(buffer.toString('utf8')), pages: null };
  if (['.txt', '.md', '.markdown', '.json', '.csv'].includes(ext)) {
    return { text: cleanText(buffer.toString('utf8')), pages: null };
  }

  throw userError(`Unsupported file type "${ext || 'unknown'}". Supported: ${SUPPORTED.join(', ')}.`);
}

/**
 * PDFs do not store paragraphs. They store lines, wrapped wherever the
 * layout happened to break, so extracted text arrives with a newline in
 * the middle of most sentences and no blank line between paragraphs.
 * Fed to the chunker as-is, a whole page looks like one block and every
 * heading disappears.
 *
 * This puts the structure back by deciding, for each line, whether it
 * continues the previous one. A line continues if the one before it did
 * not end a sentence and this one starts lowercase — the normal shape of
 * a wrapped sentence. Anything else starts a new paragraph, and short
 * unpunctuated lines are kept apart so headings survive as headings.
 */
function reflowLines(text) {
  const lines = String(text).split('\n');
  const paragraphs = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) paragraphs.push(buffer.trim());
    buffer = '';
  };

  const looksLikeHeading = (line) => {
    const t = line.trim();
    if (!t || t.length > 90) return false;
    if (/^#{1,6}\s/.test(t)) return true;                       // already markdown
    if (/^\d+(\.\d+)*[.)]\s+\S/.test(t) && !/[.!?]$/.test(t)) return true;  // "3.1 Something"
    // A short line with no sentence punctuation, starting with a capital.
    // Kept tight on purpose: too loose and ordinary short sentences become
    // section breaks, fragmenting the chunks.
    return !/[.!?,;:]$/.test(t)
      && /^[A-ZĂÂÎȘȚ0-9]/.test(t)
      && t.split(/\s+/).length <= 8;
  };

  const isListItem = (line) => /^\s*([-–—*•]|\d+[.)])\s+/.test(line);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) { flush(); continue; }
    if (isListItem(line)) { flush(); paragraphs.push(line); continue; }

    // Headings are re-emitted as markdown so the chunker has a single
    // convention to recognise, whatever the original file format was.
    if (looksLikeHeading(line)) {
      flush();
      paragraphs.push(/^#{1,6}\s/.test(line) ? line : `## ${line}`);
      continue;
    }

    if (!buffer) { buffer = line; continue; }

    const endedSentence = /[.!?:;]["')\]]?$/.test(buffer);
    const startsLower = /^[a-zăâîșț(]/.test(line);

    if (!endedSentence && startsLower) {
      buffer += ' ' + line;   // a wrapped sentence
    } else if (!endedSentence && !startsLower && buffer.length < 90) {
      buffer += ' ' + line;   // a wrapped short line, e.g. a table row
    } else {
      flush();
      buffer = line;
    }
  }
  flush();

  return paragraphs.join('\n\n');
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  let raw;
  try {
    raw = await parser.getText();
  } finally {
    await parser.destroy();
  }

  // pdf-parse marks page breaks as "-- n of m --" lines. Consuming those
  // gives both clean text and the character offsets of each page.
  // Each page is reflowed on its own, so the offsets stay in step with the
  // text that is finally stored.
  const pages = [];
  const parts = String(raw.text || '').split(/^-- (\d+) of \d+ --$/m);
  let text = '';

  if (parts.length > 1) {
    // parts alternates: [body, pageNumber, body, pageNumber, ...]
    for (let i = 0; i < parts.length; i += 2) {
      const body = reflowLines(cleanText(parts[i]));
      const pageNumber = parts[i + 1] ? Number(parts[i + 1]) : pages.length + 1;
      if (!body) continue;
      const start = text.length;
      text += (text ? '\n\n' : '') + body;
      pages.push({ page: pageNumber, start, end: text.length });
    }
  } else {
    text = reflowLines(cleanText(raw.text));
  }

  return {
    text,
    pages: pages.length ? pages : null,
    pageCount: raw.total || pages.length || null
  };
}

async function extractDocx(buffer) {
  // Converting to HTML first keeps headings, which the chunker uses as seams.
  const { value } = await mammoth.convertToHtml({ buffer });
  return { text: extractHtml(value), pages: null };
}

/**
 * A deliberately small HTML-to-text pass: strip scripts and styles, turn
 * headings into markdown so the chunker recognises them, keep paragraph
 * and list breaks, drop everything else.
 */
function extractHtml(html) {
  let out = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  for (let level = 1; level <= 6; level++) {
    out = out.replace(
      new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi'),
      (_, inner) => `\n\n${'#'.repeat(level)} ${stripTags(inner)}\n\n`
    );
  }

  out = out
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripTags(inner)}`)
    .replace(/<\/(p|div|tr|section|article|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ');

  return cleanText(decodeEntities(stripTags(out)));
}

const stripTags = (s) => String(s).replace(/<[^>]+>/g, ' ');

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' };
  return String(s)
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Flags files that produced almost no text. A scanned PDF is the usual
 * cause, and it's worth saying so plainly: no amount of clever retrieval
 * can index text that isn't there.
 */
function extractionWarnings({ text, pageCount }) {
  const warnings = [];
  const words = text.split(/\s+/).filter(Boolean).length;

  if (words < 30) {
    warnings.push('Almost no text could be read from this file. If it is a scan or a photo, it needs OCR before it can be indexed.');
  } else if (pageCount && words / pageCount < 25) {
    warnings.push(`Only about ${Math.round(words / pageCount)} words per page were readable. Parts of this document may be images.`);
  }
  return warnings;
}

module.exports = { extract, extractHtml, reflowLines, extractionWarnings, SUPPORTED };
