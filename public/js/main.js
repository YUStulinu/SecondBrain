/**
 * main.js — starts the app, runs the ask flow, and keeps the status line
 * honest about what is configured.
 */
import { $, $$, esc, toast, withBusy } from './util.js';
import { api } from './api.js';
import { renderAnswer, renderResults, initSourceDialog } from './answer.js';
import { initLibrary, refresh as refreshLibrary } from './library.js';

let status = null;

/* ---------------- views ---------------- */

function showView(name) {
  $$('.view-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  if (name === 'library') refreshLibrary();
}
$$('.view-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('.wordmark').addEventListener('click', (e) => { e.preventDefault(); showView('ask'); });
$$('[data-goto-library]').forEach((b) => b.addEventListener('click', () => showView('library')));

/* ---------------- status ---------------- */

async function loadStatus() {
  try {
    status = await api.status();
  } catch (err) {
    $('#statusLine').textContent = 'Server unreachable';
    return;
  }

  const parts = [];
  if (status.chunks) parts.push(`${status.chunks.toLocaleString()} passages indexed`);
  if (status.embedding) parts.push(status.embedding.model.split('/').pop());
  $('#statusLine').textContent = parts.join(' · ');

  const banner = $('#setupBanner');
  const problems = [];

  if (status.embeddingSetting.provider === 'hash') {
    problems.push('Embeddings are set to <code>hash</code>, which has no understanding of meaning — useful only for trying the plumbing. Set <code>EMBEDDING_PROVIDER=local</code> in <code>.env</code> and run <code>npm run setup:local</code>.');
  }
  if (!status.answering) {
    problems.push('No <code>ANTHROPIC_API_KEY</code>, so questions return passages but no written answer. Search works fully.');
  }
  if (status.embedding && status.embedding.model !== status.embeddingSetting.model) {
    problems.push(`The index was built with <code>${esc(status.embedding.model)}</code> but <code>.env</code> now says <code>${esc(status.embeddingSetting.model)}</code>. Vectors from two models cannot be compared — restore the old setting, or run <code>npm run reindex</code>.`);
  }

  banner.innerHTML = problems.map((p) => `<p>${p}</p>`).join('');
  banner.hidden = problems.length === 0;

  $('#askEmpty').hidden = status.chunks > 0;
}

/* ---------------- ask ---------------- */

$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = $('#question').value.trim();
  if (!question) return;

  const mode = $('#askMode').value;
  const collection = $('#collectionFilter').value || null;

  $('#askEmpty').hidden = true;
  $('#answerPanel').hidden = true;
  $('#resultsPanel').hidden = true;
  $('#askLoading').hidden = false;
  $('#askLoadingText').textContent = mode === 'answer'
    ? 'Searching your library…'
    : 'Searching…';

  // The answer step is the slow one; say so rather than leaving a spinner.
  const phase = setTimeout(() => {
    if (mode === 'answer') $('#askLoadingText').textContent = 'Reading the passages and writing the answer…';
  }, 1200);

  await withBusy($('#askBtn'), '…', async () => {
    try {
      if (mode === 'answer') {
        if (!status?.answering) throw new Error('Answering needs ANTHROPIC_API_KEY in .env. Switch to "Search only" to browse passages.');
        const data = await api.ask({ q: question, collection });
        // Hide the spinner before painting, so the two are never on screen together.
        clearTimeout(phase);
        $('#askLoading').hidden = true;
        renderAnswer(data);
      } else {
        const data = await api.search({ q: question, collection, limit: 15 });
        clearTimeout(phase);
        $('#askLoading').hidden = true;
        renderResults(data, question);
      }
      loadRecent();
    } catch (err) {
      toast(err.message, 'error');
      $('#askEmpty').hidden = Boolean(status?.chunks);
    } finally {
      clearTimeout(phase);
      $('#askLoading').hidden = true;
    }
  });
});

// Enter submits; Shift+Enter makes a new line.
$('#question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#askForm').requestSubmit();
  }
});

async function loadRecent() {
  try {
    const { queries } = await api.queries();
    const box = $('#recentQueries');
    if (!queries.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <h2 class="section-title">Recent questions</h2>
      <div class="recent-list">
        ${queries.slice(0, 8).map((q) => `<button class="recent-item">${esc(q.question)}</button>`).join('')}
      </div>`;
    $$('.recent-item', box).forEach((btn) => btn.addEventListener('click', () => {
      $('#question').value = btn.textContent;
      $('#askForm').requestSubmit();
    }));
  } catch { /* the history is a convenience, not essential */ }
}

/* ---------------- start ---------------- */

initSourceDialog();
initLibrary({
  onLibraryChange: () => loadStatus()
});
loadStatus();
loadRecent();
