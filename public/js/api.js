/** api.js — REST client. */
async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error('Could not reach the server. Is it still running?'); }

  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export const api = {
  status: () => request('GET', '/api/status'),
  documents: () => request('GET', '/api/documents'),
  document: (id) => request('GET', `/api/documents/${id}`),
  upload: (form) => request('POST', '/api/documents/upload', form),
  addNote: (body) => request('POST', '/api/documents/text', body),
  remove: (id) => request('DELETE', `/api/documents/${id}`),
  search: (body) => request('POST', '/api/search', body),
  ask: (body) => request('POST', '/api/ask', body),
  queries: () => request('GET', '/api/queries'),
  context: (chunkId, span = 2) => request('GET', `/api/chunks/${chunkId}/context?span=${span}`)
};
