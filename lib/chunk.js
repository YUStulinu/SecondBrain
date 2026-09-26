/**
 * chunk.js — cutting a document into retrievable pieces.
 *
 * This is the single biggest quality lever in a RAG system, and the least
 * glamorous. Three rules drive the design:
 *
 *  1. Cut on structure, not on character count. A chunk that begins
 *     mid-sentence retrieves badly, because its embedding is an average of
 *     two unrelated halves. Paragraphs and headings are natural seams.
 *
 *  2. Overlap the seams. If the answer straddles a boundary, a chunk with
 *     no overlap contains half of it and reads as incoherent. Carrying the
 *     last sentence or two forward costs a little storage and rescues those
 *     cases.
 *
 *  3. Carry the heading into the chunk. A paragraph reading "It defaults to
 *     three retries" means nothing alone; prefixed with "Retry policy" it
 *     becomes findable — and the embedding gets the topic it was missing.
 *
 * Size: ~900 characters (≈220 tokens). Small enough that a retrieved chunk
 * is mostly signal, large enough to hold a whole argument. Very small chunks
 * retrieve precisely but answer poorly; very large ones do the opposite.
 */
const { estimateTokens } = require('./text');

const TARGET_CHARS = 900;
const MAX_CHARS = 1400;   // hard ceiling before a paragraph is split by sentence
const MIN_CHARS = 120;    // below this, a chunk is merged into its neighbour
const OVERLAP_CHARS = 180;

/** Markdown headings, numbered sections, and short all-caps lines. */
function detectHeading(line) {
  const t = line.trim();
  if (!t || t.length > 120) return null;
  const md = t.match(/^(#{1,6})\s+(.+)$/);
  if (md) return { level: md[1].length, text: md[2].trim() };
  if (/^\d+(\.\d+)*[.)]?\s+\S/.test(t) && t.length < 100 && !/[.!?]$/.test(t)) {
    return { level: 2, text: t };
  }
  // A short line in capitals, with no sentence punctuation, is usually a heading.
  if (t.length < 70 && t === t.toUpperCase() && /[A-ZĂÂÎȘȚ]/.test(t) && !/[.!?;:]$/.test(t)) {
    return { level: 2, text: t };
  }
  return null;
}

/**
 * Splits text into blocks, each tagged with its offset and the heading it
 * sits under. Offsets are kept so a chunk can be located in the original
 * text later and highlighted.
 */
function toBlocks(text) {
  const blocks = [];
  let heading = '';
  let offset = 0;

  for (const rawPara of text.split(/\n\s*\n/)) {
    const start = text.indexOf(rawPara, offset);
    offset = start + rawPara.length;
    const para = rawPara.trim();
    if (!para) continue;

    // A heading may be the whole block, or its first line.
    const lines = para.split('\n');
    const asHeading = detectHeading(lines[0]);

    if (asHeading && lines.length === 1) {
      heading = asHeading.text;
      continue;
    }
    if (asHeading) {
      heading = asHeading.text;
      const rest = lines.slice(1).join('\n').trim();
      if (!rest) continue;
      blocks.push({ text: rest, heading, start: start + para.indexOf(rest), end: start + para.length });
      continue;
    }

    blocks.push({ text: para, heading, start, end: start + rawPara.length });
  }

  return blocks;
}

/** Sentence boundaries, tolerant of abbreviations and decimals. */
function splitSentences(text) {
  const parts = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g) || [text];
  const out = [];
  let buffer = '';

  for (const part of parts) {
    buffer += part;
    const trimmed = buffer.trim();
    // Don't break after "art." / "nr." / "Fig." or a number-only fragment.
    if (/\b([A-Za-zĂÂÎȘȚăâîșț]{1,4}|\d+)\.\s*$/.test(trimmed) && trimmed.length < 400) continue;
    if (trimmed.length >= 40 || /[.!?]["')\]]*\s*$/.test(trimmed)) {
      out.push(buffer);
      buffer = '';
    }
  }
  if (buffer.trim()) out.push(buffer);
  return out;
}

/** The last whole sentences of a chunk, up to `max` characters, for overlap. */
function tailSentences(text, max = OVERLAP_CHARS) {
  const sentences = splitSentences(text);
  let out = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (out.length + sentences[i].length > max && out) break;
    out = sentences[i] + out;
  }
  return out.trim();
}

/**
 * chunkText(text, { pages }) -> [{ text, heading, page, charStart, charEnd, tokenEst }]
 *
 * `pages` is an optional [{ page, start, end }] map from the extractor, so
 * a chunk can report which page of a PDF it came from.
 */
function chunkText(text, { pages = null, target = TARGET_CHARS, maxChars = MAX_CHARS, overlap = OVERLAP_CHARS } = {}) {
  const blocks = toBlocks(text);
  const chunks = [];

  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) { current = null; return; }
    const body = current.text.trim();
    chunks.push({
      text: body,
      heading: current.heading,
      charStart: current.start,
      charEnd: current.end,
      page: pages ? pageFor(pages, current.start) : null,
      tokenEst: estimateTokens(body)
    });
    current = null;
  };

  /**
   * Overlap exists to rescue an answer that runs across a seam. At a
   * section boundary there is no flow to rescue, and carrying text over
   * would put one topic inside a chunk labelled with another — which
   * pollutes its embedding and makes the citation misleading. So overlap
   * is only taken from a previous chunk in the same section.
   */
  const carryFor = (block) => {
    const previous = chunks[chunks.length - 1];
    if (!previous || previous.heading !== block.heading) return '';
    return tailSentences(previous.text, overlap);
  };

  const startChunk = (block, carry) => {
    current = {
      heading: block.heading,
      // Overlap text is prepended but the offsets still point at this block,
      // so highlighting lands on the new material rather than the repeat.
      text: carry ? carry + '\n' + block.text : block.text,
      start: block.start,
      end: block.end
    };
  };

  for (const block of blocks) {
    // A block bigger than the ceiling is split on sentences first.
    const pieces = block.text.length > maxChars
      ? packSentences(block.text, target, maxChars)
      : [block.text];

    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const pieceBlock = { ...block, text: piece };

      if (!current) {
        startChunk(pieceBlock, carryFor(pieceBlock));
        continue;
      }

      const wouldBe = current.text.length + 1 + piece.length;
      const headingChanged = block.heading !== current.heading;

      // Start a new chunk when the section changes or the size is reached.
      if (headingChanged || wouldBe > maxChars || (wouldBe > target && current.text.length >= MIN_CHARS)) {
        flush();
        startChunk(pieceBlock, carryFor(pieceBlock));
      } else {
        current.text += '\n' + piece;
        current.end = block.end;
      }
    }
  }
  flush();

  return mergeTiny(chunks, maxChars);
}

/** Packs sentences into pieces of about `target`, never exceeding `maxChars`. */
function packSentences(text, target, maxChars) {
  const out = [];
  let buffer = '';
  for (const sentence of splitSentences(text)) {
    if (buffer && (buffer.length + sentence.length > target)) {
      out.push(buffer.trim());
      buffer = '';
    }
    // A single sentence longer than the ceiling (tables, long lists) is cut hard.
    if (sentence.length > maxChars) {
      if (buffer) { out.push(buffer.trim()); buffer = ''; }
      for (let i = 0; i < sentence.length; i += target) out.push(sentence.slice(i, i + target).trim());
      continue;
    }
    buffer += sentence;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out.filter(Boolean);
}

/** A stray short chunk retrieves poorly; fold it into its neighbour. */
function mergeTiny(chunks, maxChars) {
  const out = [];
  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    if (prev && chunk.text.length < MIN_CHARS &&
        prev.heading === chunk.heading &&
        prev.text.length + chunk.text.length < maxChars) {
      prev.text += '\n' + chunk.text;
      prev.charEnd = chunk.charEnd;
      prev.tokenEst = estimateTokens(prev.text);
      continue;
    }
    out.push(chunk);
  }
  return out;
}

function pageFor(pages, offset) {
  for (const p of pages) {
    if (offset >= p.start && offset < p.end) return p.page;
  }
  return pages.length ? pages[pages.length - 1].page : null;
}

/**
 * What actually gets embedded. The heading is folded into the text so the
 * vector carries the topic, not just the sentence — this alone noticeably
 * improves retrieval on documents full of short paragraphs.
 */
function embeddableText(chunk, documentTitle) {
  const context = [documentTitle, chunk.heading].filter(Boolean).join(' › ');
  return context ? `${context}\n\n${chunk.text}` : chunk.text;
}

module.exports = { chunkText, embeddableText, splitSentences, detectHeading, TARGET_CHARS };
