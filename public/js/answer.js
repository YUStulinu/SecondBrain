/**
 * answer.js — showing the answer, and showing its work.
 *
 * A retrieval system is only trustworthy if you can check it, so the UI is
 * built around that: every citation marker in the prose is a button that
 * opens the exact passage it came from, each result says which method
 * found it and at what rank, and anything the verifier threw out is
 * reported rather than quietly hidden.
 */
import { $, $$, esc, toast, formatMs } from './util.js';
import { api } from './api.js';

let lastResponse = null;

const CONFIDENCE = {
  high: { label: 'Answered from your documents', tone: 'good' },
  partial: { label: 'Partly answered', tone: 'warn' },
  none: { label: 'Not covered by your documents', tone: 'none' }
};

export function renderAnswer(data) {
  lastResponse = data;
  const panel = $('#answerPanel');
  const conf = CONFIDENCE[data.confidence] || CONFIDENCE.partial;
  const v = data.stats.verification;

  // Turn [S1] markers into buttons that open the cited passage.
  const byMarker = new Map(data.citations.map((c) => [c.marker, c]));
  const prose = esc(data.answer).replace(/\[(S\d+|unverified)\]/g, (match, marker) => {
    if (marker === 'unverified') {
      return '<span class="cite cite-bad" title="This claim had a citation, but the quote could not be found in the source it named, so it was removed.">unverified</span>';
    }
    const c = byMarker.get(marker);
    if (!c) return '';
    return `<button class="cite" data-cite="${esc(marker)}" title="${esc(c.documentTitle)}">${esc(marker)}</button>`;
  });

  const droppedNote = v.dropped.length ? `
    <details class="dropped">
      <summary>${v.dropped.length} citation${v.dropped.length > 1 ? 's were' : ' was'} rejected</summary>
      <p class="fine">Each quote is checked against the passage it claims to come from. These did not match, so the claims they supported were marked unverified.</p>
      <ul>${v.dropped.map((x) => `<li><code>${esc(x.marker)}</code> — ${esc(x.reason)}<br><span class="fine">“${esc(x.quote.slice(0, 120))}”</span></li>`).join('')}</ul>
    </details>` : '';

  panel.innerHTML = `
    <div class="answer-head">
      <span class="confidence conf-${conf.tone}">${conf.label}</span>
      <span class="answer-stats">${data.stats.retrieved} passages · ${formatMs(data.stats.totalMs)}</span>
    </div>

    <div class="answer-prose">${prose}</div>

    ${data.missing ? `<p class="missing"><strong>Not in your documents:</strong> ${esc(data.missing)}</p>` : ''}

    ${data.citations.length ? `
      <section class="citations">
        <h3>Sources for this answer</h3>
        <ol class="citation-list">
          ${data.citations.map((c) => `
            <li class="citation" data-marker="${esc(c.marker)}">
              <button class="citation-open" data-chunk="${c.chunkId}">
                <span class="cite-marker">${esc(c.marker)}</span>
                <span class="cite-where">${esc(c.documentTitle)}${c.heading ? ` › ${esc(c.heading)}` : ''}${c.page ? ` · page ${c.page}` : ''}</span>
              </button>
              <blockquote class="cite-quote">${c.excerpt || esc(c.quote)}</blockquote>
            </li>`).join('')}
        </ol>
      </section>` : ''}

    ${droppedNote}

    <details class="retrieval">
      <summary>How these passages were found</summary>
      <p class="fine">
        Keyword search returned ${data.stats.counts.keyword}, vector search returned ${data.stats.counts.vector},
        and the two rankings were merged. A passage both methods rank highly wins; one that only one method found still
        places, which is what rescues exact terms the vectors miss and paraphrases the keywords miss.
      </p>
      <ol class="provenance">
        ${data.results.map((r, i) => `
          <li>
            <span class="prov-rank">${i + 1}</span>
            <button class="prov-title" data-chunk="${r.chunkId}">${esc(r.documentTitle)}${r.heading ? ` › ${esc(r.heading)}` : ''}${r.page ? ` · p.${r.page}` : ''}</button>
            <span class="prov-tags">
              ${r.ranks.keyword ? `<span class="tag tag-kw">keyword #${r.ranks.keyword}</span>` : ''}
              ${r.ranks.vector ? `<span class="tag tag-vec">vector #${r.ranks.vector}${r.similarity != null ? ` · ${(r.similarity * 100).toFixed(0)}%` : ''}</span>` : ''}
            </span>
          </li>`).join('')}
      </ol>
    </details>
  `;

  panel.hidden = false;
  $('#resultsPanel').hidden = true;
  wireChunkButtons(panel);

  // Clicking a marker in the prose scrolls to and flashes its source entry.
  $$('[data-cite]', panel).forEach((btn) => btn.addEventListener('click', () => {
    const target = panel.querySelector(`.citation[data-marker="${btn.dataset.cite}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('is-flash');
    setTimeout(() => target.classList.remove('is-flash'), 1200);
  }));
}

export function renderResults(data, question) {
  const panel = $('#resultsPanel');
  if (!data.results.length) {
    panel.innerHTML = `<div class="empty"><p>Nothing matched “${esc(question)}”. Try other words, or check that the document is indexed.</p></div>`;
    panel.hidden = false;
    $('#answerPanel').hidden = true;
    return;
  }

  panel.innerHTML = `
    <p class="results-summary">
      ${data.results.length} passages · keyword ${data.counts.keyword}, vector ${data.counts.vector} · ${formatMs(data.timings.total)}
    </p>
    ${data.results.map((r) => `
      <article class="result">
        <header>
          <button class="result-title" data-chunk="${r.chunkId}">${esc(r.documentTitle)}</button>
          <span class="result-where">${r.heading ? esc(r.heading) : ''}${r.page ? ` · page ${r.page}` : ''}</span>
        </header>
        <p class="result-excerpt">${r.excerpt}</p>
        <div class="result-tags">
          ${r.ranks.keyword ? `<span class="tag tag-kw">keyword #${r.ranks.keyword}</span>` : ''}
          ${r.ranks.vector ? `<span class="tag tag-vec">vector #${r.ranks.vector}</span>` : ''}
        </div>
      </article>`).join('')}
  `;
  panel.hidden = false;
  $('#answerPanel').hidden = true;
  wireChunkButtons(panel);
}

/* ---------------- source dialog ---------------- */

let openChunkId = null;

function wireChunkButtons(root) {
  $$('[data-chunk]', root).forEach((btn) =>
    btn.addEventListener('click', () => openSource(Number(btn.dataset.chunk))));
}

async function openSource(chunkId, span = 0) {
  openChunkId = chunkId;
  const dialog = $('#sourceDialog');

  try {
    const { chunks } = await api.context(chunkId, Math.max(span, 0));
    const focus = chunks.find((c) => c.id === chunkId) || chunks[0];
    const citation = lastResponse?.citations.find((c) => c.chunkId === chunkId);

    $('#sourceTitle').textContent = focus.heading || 'Passage';
    $('#sourceMeta').textContent = [
      lastResponse?.results.find((r) => r.chunkId === chunkId)?.documentTitle,
      focus.page ? `page ${focus.page}` : null,
      `passage ${focus.ordinal + 1}`
    ].filter(Boolean).join(' · ');

    $('#sourceBody').innerHTML = chunks.map((c) => {
      const isFocus = c.id === chunkId;
      let body = esc(c.text);
      // Highlight the quoted sentence inside its passage.
      if (isFocus && citation) {
        const needle = esc(citation.quote).slice(0, 80);
        const at = body.toLowerCase().indexOf(needle.toLowerCase());
        if (at >= 0) {
          body = body.slice(0, at) + '<mark>' + body.slice(at, at + needle.length) + '</mark>' + body.slice(at + needle.length);
        }
      }
      return `<div class="passage ${isFocus ? 'is-focus' : 'is-context'}">
        ${c.heading ? `<p class="passage-heading">${esc(c.heading)}</p>` : ''}
        <p>${body}</p>
      </div>`;
    }).join('');

    $('#moreContext').hidden = false;
    if (!dialog.open) dialog.showModal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function initSourceDialog() {
  const dialog = $('#sourceDialog');
  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));
  $('#moreContext').addEventListener('click', () => openSource(openChunkId, 3));
}
