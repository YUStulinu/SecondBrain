/**
 * library.js — adding documents, and watching them index.
 *
 * Indexing runs on the server's queue, so the page has to be told what is
 * happening rather than waiting for a response. It subscribes to a
 * Server-Sent Events stream: one long-lived HTTP response the server writes
 * progress into. The browser reconnects on its own if it drops, which is
 * the main reason to prefer it over a WebSocket for one-way updates.
 */
import { $, $$, esc, toast, formatBytes, formatDate, withBusy } from './util.js';
import { api } from './api.js';

let documents = [];
let collections = [];
const progress = new Map();   // documentId -> latest progress event
let onChange = () => {};

export function initLibrary({ onLibraryChange }) {
  onChange = onLibraryChange || (() => {});
  wireUpload();
  wireNote();
  connectEvents();
  refresh();
}

export function getDocuments() { return documents; }
export function getCollections() { return collections; }

export async function refresh() {
  try {
    const data = await api.documents();
    documents = data.documents;
    collections = data.collections;
    renderDocuments();
    renderCollectionOptions();
    onChange({ documents, collections });
  } catch (err) {
    $('#docList').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

/* ---------------- live progress ---------------- */

function connectEvents() {
  const source = new EventSource('/api/events');

  source.addEventListener('progress', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    progress.set(data.documentId, data);
    updateProgressRow(data);

    if (data.stage === 'ready' || data.stage === 'failed') {
      // Pull the authoritative record once a document settles.
      setTimeout(() => { progress.delete(data.documentId); refresh(); }, 400);
      if (data.stage === 'failed') toast(`Indexing failed: ${data.error}`, 'error');
    }
  });

  // EventSource reconnects by itself; this only surfaces a long outage.
  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) {
      toast('Lost the connection to the server.', 'error');
    }
  });
}

const STAGE_TEXT = {
  queued: 'Waiting',
  extracting: 'Reading the file',
  chunking: 'Splitting into passages',
  embedding: 'Building embeddings',
  ready: 'Indexed',
  failed: 'Failed'
};

function updateProgressRow(data) {
  const row = document.querySelector(`.doc[data-id="${data.documentId}"]`);
  if (!row) return;
  const bar = row.querySelector('.progress-fill');
  const label = row.querySelector('.doc-status');
  if (bar) bar.style.width = `${data.percent || 0}%`;
  if (label) {
    label.textContent = data.chunksDone
      ? `${STAGE_TEXT[data.stage]} — ${data.chunksDone}/${data.chunks}`
      : STAGE_TEXT[data.stage] || data.stage;
  }
  row.dataset.stage = data.stage;
}

/* ---------------- adding ---------------- */

function wireUpload() {
  const input = $('#fileInput');
  const zone = $('#dropzone');

  const show = () => {
    const files = [...(input.files || [])];
    $('#dropTitle').textContent = files.length
      ? `${files.length} file${files.length > 1 ? 's' : ''} ready`
      : 'Drop files here, or click to choose';
    $('#dropHint').textContent = files.length
      ? files.map((f) => f.name).join(', ').slice(0, 120)
      : 'PDF, DOCX, TXT, MD, HTML — up to 50 MB each';
  };

  input.addEventListener('change', show);
  ['dragover', 'dragenter'].forEach((e) => zone.addEventListener(e, (ev) => {
    ev.preventDefault(); zone.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((e) => zone.addEventListener(e, (ev) => {
    ev.preventDefault(); zone.classList.remove('is-over');
  }));
  zone.addEventListener('drop', (ev) => {
    if (ev.dataTransfer.files?.length) { input.files = ev.dataTransfer.files; show(); }
  });

  $('#uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const files = [...(input.files || [])];
    if (!files.length) { toast('Choose at least one file.', 'error'); return; }

    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    form.append('collection', $('#uploadCollection').value.trim());

    await withBusy($('#uploadBtn'), 'Uploading…', async () => {
      try {
        const { added } = await api.upload(form);
        const duplicates = added.filter((a) => a.duplicate);
        const failed = added.filter((a) => a.error);
        const fresh = added.length - duplicates.length - failed.length;

        if (fresh) toast(`${fresh} document${fresh > 1 ? 's' : ''} queued for indexing`);
        if (duplicates.length) toast(`${duplicates.length} already in your library — skipped`, 'info');
        failed.forEach((f) => toast(`${f.filename}: ${f.error}`, 'error'));

        input.value = '';
        show();
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

function wireNote() {
  $('#noteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#noteTitle').value.trim();
    const text = $('#noteText').value.trim();

    await withBusy($('#noteBtn'), 'Adding…', async () => {
      try {
        const result = await api.addNote({ title, text, collection: $('#uploadCollection').value.trim() });
        toast(result.duplicate ? 'You already have this note' : 'Note added');
        if (!result.duplicate) { $('#noteTitle').value = ''; $('#noteText').value = ''; }
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* ---------------- rendering ---------------- */

function renderCollectionOptions() {
  $('#collectionList').innerHTML = collections.map((c) => `<option value="${esc(c)}"></option>`).join('');
  const filter = $('#collectionFilter');
  const chosen = filter.value;
  filter.innerHTML = '<option value="">Everything</option>' +
    collections.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (collections.includes(chosen)) filter.value = chosen;
}

function renderDocuments() {
  const list = $('#docList');
  $('#docCount').textContent = documents.length || '';

  if (!documents.length) {
    list.innerHTML = '<div class="empty"><p>No documents yet. Add a file or paste a note above.</p></div>';
    return;
  }

  list.innerHTML = documents.map((doc) => {
    const live = progress.get(doc.id);
    const stage = live?.stage || doc.status;
    const busy = !['ready', 'failed'].includes(stage);
    const percent = live?.percent ?? (doc.status === 'ready' ? 100 : 0);

    const facts = [
      doc.chunkCount ? `${doc.chunkCount} passages` : null,
      doc.pageCount ? `${doc.pageCount} pages` : null,
      formatBytes(doc.byteSize),
      doc.collection ? esc(doc.collection) : null,
      formatDate(doc.addedAt)
    ].filter(Boolean);

    return `
      <article class="doc" data-id="${doc.id}" data-stage="${esc(stage)}">
        <div class="doc-main">
          <p class="doc-title">${esc(doc.title)}</p>
          <p class="doc-facts">${facts.join(' · ')}</p>
          ${doc.note ? `<p class="doc-note">${esc(doc.note)}</p>` : ''}
          ${busy ? `<div class="progress"><div class="progress-fill" style="width:${percent}%"></div></div>` : ''}
        </div>
        <div class="doc-side">
          <span class="doc-status ${stage === 'failed' ? 'is-failed' : ''}">${esc(STAGE_TEXT[stage] || stage)}</span>
          <button class="btn btn-quiet btn-small" data-remove="${doc.id}">Remove</button>
        </div>
      </article>`;
  }).join('');

  $$('[data-remove]', list).forEach((btn) => btn.addEventListener('click', async () => {
    const doc = documents.find((d) => d.id === Number(btn.dataset.remove));
    if (!confirm(`Remove “${doc.title}” and everything indexed from it?`)) return;
    try {
      await api.remove(doc.id);
      toast('Document removed');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }));
}
