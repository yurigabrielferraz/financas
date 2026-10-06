// Cliente da API REST. Todos os valores monetários são em centavos.
// Se o servidor exigir token (FINANCAS_TOKEN), ele é pedido uma vez e guardado neste navegador.

function getToken() {
  try { return localStorage.getItem('token') || ''; } catch { return ''; }
}

let asking = null;
function askToken() {
  asking ??= Promise.resolve().then(() => {
    const t = prompt('Este servidor exige um token de acesso. Cole o token:');
    if (t) { try { localStorage.setItem('token', t.trim()); } catch { /* sem storage */ } }
    asking = null;
    return !!t;
  });
  return asking;
}

export async function apiFetch(path, opts = {}, retry = true) {
  const token = getToken();
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
  });
  if (res.status === 401 && retry && await askToken()) return apiFetch(path, opts, false);
  return res;
}

async function request(method, path, body) {
  const res = await apiFetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      msg = typeof j.detail === 'string' ? j.detail : j.detail.map(d => `${d.loc.at(-1)}: ${d.msg}`).join('; ');
    } catch { /* corpo não-JSON */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

export async function downloadBackup() {
  const res = await apiFetch('/backup');
  if (!res.ok) throw new Error(`Falha ao gerar backup (${res.status})`);
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'financas-backup.db';
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

export const api = {
  get: p => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: p => request('DELETE', p),
};
