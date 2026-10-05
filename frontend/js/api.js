// Cliente da API REST. Todos os valores monetários são em centavos.
async function request(method, path, body) {
  const res = await fetch('/api' + path, {
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

export const api = {
  get: p => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: p => request('DELETE', p),
};
