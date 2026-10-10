// Mesma interface de antes (api.get/post/put/del), mas atendida pelo "servidor" que roda no
// navegador (core/server.js) em vez de HTTP. Valores monetários em centavos.
import { store } from './store.js';

function request(method, path, body) {
  const res = store.server.handle(method, path, body);
  if (res.status >= 400) throw new Error(typeof res.body?.detail === 'string' ? res.body.detail : `Erro ${res.status}`);
  if (method !== 'GET' && !path.endsWith('/preview')) store.markDirty();
  return Promise.resolve(res.body);
}

export function downloadBackup() {
  const d = new Date();
  const name = `financas-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.db`;
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([store.exportBytes()], { type: 'application/octet-stream' })), download: name,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return Promise.resolve();
}

export const api = {
  get: p => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: p => request('DELETE', p),
};
