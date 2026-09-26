/**
 * answer.js — writing the answer, and refusing to let it drift.
 *
 * Retrieval-augmented generation is often sold as "grounded" simply because
 * documents were put in the prompt. That isn't grounding, it's hope: the
 * model can still blend a real passage with something it remembers from
 * training, and the result reads exactly as confident either way.
 *
 * So the answer is built in a checkable form. The model must attach a
 * verbatim quote to every claim, naming the chunk it came from. Afterwards
 * the code goes and looks: does that chunk exist, was it actually
 * retrieved, and does the quote really appear in it? A citation that fails
 * any of those is dropped and the sentence it supported is flagged.
 *
 * The other half of grounding is permission to say no. The prompt makes
 * "the documents don't cover this" a correct answer, because a knowledge
 * base that invents an answer for a question you have no notes on is worse
 * than useless — it is confidently wrong about your own material.
 */
const { quoteAppearsIn } = require('./text');

const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const MAX_CONTEXT_TOKENS = 12000;

const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

function aiError(message, status = 502) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function callClaude({ system, user, maxTokens = 2000 }) {
  if (!hasApiKey()) {
    throw aiError('Missing ANTHROPIC_API_KEY. Search still works without it; answering does not.', 500);
  }

  const body = JSON.stringify({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }]
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body
    });

    if (res.ok) {
      const data = await res.json();
      if (data.stop_reason === 'max_tokens') throw aiError('The answer was cut off. Try a narrower question.');
      const block = (data.content || []).find((c) => c.type === 'text');
      return { text: block ? block.text : '', usage: data.usage || null };
    }

    const detail = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (res.status === 401) throw aiError('Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env.');
    if (res.status === 429) throw aiError('Rate limit reached. Wait a moment and try again.', 429);
    console.error('Anthropic error:', res.status, detail.slice(0, 300));
    throw aiError('The AI service returned an error. Try again shortly.');
  }
  throw aiError('The AI service is busy. Try again shortly.');
}

function parseJson(raw) {
  const cleaned = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('no JSON object in reply');
  return JSON.parse(cleaned.slice(a, b + 1));
}

/**
 * Packs retrieved chunks into the prompt until the budget runs out, best
 * first. Each is labelled with a short id the model must cite by.
 */
function buildContext(results, budgetTokens = MAX_CONTEXT_TOKENS) {
  const used = [];
  let tokens = 0;

  for (const [i, r] of results.entries()) {
    const estimate = Math.ceil(r.text.length / 4) + 40;
    if (tokens + estimate > budgetTokens && used.length) break;
    tokens += estimate;
    used.push({ ...r, label: `S${i + 1}` });
  }

  const blocks = used.map((r) => {
    const where = [r.documentTitle, r.heading, r.page ? `page ${r.page}` : null].filter(Boolean).join(' › ');
    return `<source id="${r.label}" from="${where}">\n${r.text}\n</source>`;
  });

  return { context: blocks.join('\n\n'), used, tokens };
}

const SYSTEM = `You answer questions using only the sources provided, which come from the user's own document library.

Reply with ONLY a JSON object, no prose, in exactly this shape:
{
  "answer": "the answer in plain prose, with a citation marker like [S1] after each claim that comes from a source",
  "citations": [
    { "marker": "S1", "quote": "a VERBATIM sentence or phrase copied from that source, 5 to 30 words, proving the claim" }
  ],
  "confidence": "high" | "partial" | "none",
  "missing": "if the sources only partly answer the question, say briefly what is missing; otherwise an empty string"
}

Rules:
- Use only what is in the sources. Never add facts from your own knowledge, not even obviously true ones. If you know something relevant that the sources don't contain, leave it out.
- If the sources don't answer the question, set "confidence" to "none" and say so in "answer". That is a correct and useful reply — it tells the user their library has a gap. Do not stretch loosely related material into an answer.
- If they answer part of it, set "confidence" to "partial", answer that part, and put the rest in "missing".
- Every citation "quote" must be copied character for character from the source it names. It is checked automatically; a quote that cannot be found is discarded along with the claim it supported.
- Cite each source you rely on at least once, and put the marker immediately after the claim it supports.
- Where sources disagree, say so and cite both rather than silently choosing one.
- Write in the same language as the question. If the question is in Romanian and the sources are in English, answer in Romanian and keep the quotes in their original English.
- Be direct and compact. No preamble, no "based on the provided documents", no restating the question.`;

/**
 * answerQuestion(question, results) -> verified answer
 *
 * `results` come from search(). Nothing outside them can end up cited.
 */
async function answerQuestion(question, results, { language = 'auto' } = {}) {
  if (!results.length) {
    return {
      answer: 'Nothing in your library matches this question. Try different wording, or add the document that would cover it.',
      citations: [],
      confidence: 'none',
      missing: '',
      verification: { checked: 0, kept: 0, dropped: [] },
      usedSources: []
    };
  }

  const { context, used } = buildContext(results);
  const languageNote = language === 'auto' ? '' :
    `\n\nWrite the answer in ${language === 'ro' ? 'Romanian' : 'English'}, whatever language the question uses.`;

  const { text, usage } = await callClaude({
    system: SYSTEM,
    user: `SOURCES\n\n${context}\n\nQUESTION\n${question}${languageNote}`
  });

  let parsed;
  try {
    parsed = parseJson(text);
  } catch {
    const retry = await callClaude({
      system: SYSTEM,
      user: `SOURCES\n\n${context}\n\nQUESTION\n${question}\n\nIMPORTANT: your previous reply was not valid JSON. Reply with ONLY the JSON object.`
    });
    parsed = parseJson(retry.text);
  }

  return verify(parsed, used, usage);
}

/**
 * The check. Every citation must name a source that was actually retrieved
 * and quote text that actually appears in it.
 */
function verify(parsed, used, usage) {
  const byLabel = new Map(used.map((u) => [u.label, u]));
  const kept = [];
  const dropped = [];

  for (const raw of parsed.citations || []) {
    const marker = String(raw?.marker || '').trim().toUpperCase();
    const quote = String(raw?.quote || '').trim();
    const source = byLabel.get(marker);

    if (!source) {
      dropped.push({ marker, quote, reason: 'cites a source that was not retrieved' });
      continue;
    }
    if (!quote) {
      dropped.push({ marker, quote, reason: 'no quote given' });
      continue;
    }
    if (!quoteAppearsIn(quote, source.text)) {
      dropped.push({ marker, quote, reason: 'the quote does not appear in that source' });
      continue;
    }

    kept.push({
      marker,
      quote,
      chunkId: source.chunkId,
      documentId: source.documentId,
      documentTitle: source.documentTitle,
      heading: source.heading,
      page: source.page,
      ordinal: source.ordinal
    });
  }

  let answer = String(parsed.answer || '').trim();

  // Markers whose citation was discarded would otherwise point at nothing.
  const keptMarkers = new Set(kept.map((c) => c.marker));
  const unsupported = [...new Set(
    (answer.match(/\[S\d+\]/g) || []).map((m) => m.slice(1, -1))
  )].filter((m) => !keptMarkers.has(m));

  for (const marker of unsupported) {
    answer = answer.replaceAll(`[${marker}]`, '[unverified]');
  }

  let confidence = ['high', 'partial', 'none'].includes(parsed.confidence) ? parsed.confidence : 'partial';

  // Confidence is the model's own claim, so it is corrected against what
  // actually survived checking. An answer where half the citations were
  // fabricated is not a confident answer, whatever the model said.
  const total = kept.length + dropped.length;
  if (!kept.length && confidence !== 'none') confidence = 'partial';
  else if (total && dropped.length / total >= 0.34 && confidence === 'high') confidence = 'partial';

  return {
    answer,
    citations: kept,
    confidence,
    missing: String(parsed.missing || '').trim(),
    verification: {
      checked: (parsed.citations || []).length,
      kept: kept.length,
      dropped,
      unsupportedMarkers: unsupported
    },
    usedSources: used.map((u) => ({
      label: u.label, chunkId: u.chunkId, documentId: u.documentId,
      documentTitle: u.documentTitle, heading: u.heading, page: u.page
    })),
    usage
  };
}

module.exports = { answerQuestion, buildContext, verify, hasApiKey };
