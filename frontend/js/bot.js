// Bot do Telegram: um script no Google Apps Script do usuário lê as mensagens, entende com o Gemini e
// anota os lançamentos numa "caixa de entrada" no Drive. Aqui o app grava o que chegou no banco e
// publica o contexto (categorias, contas, cartões, exemplos) que o script usa para entender as mensagens.
// Cada arquivo tem um só escritor: a entrada é do script; o contexto, do app. Sem disputa entre os dois.
// Os dois arquivos são criados pelo app (o escopo drive.file só enxerga o que o app criou).

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const INBOX = 'minhas-financas-telegram.json';
export const CONTEXT = 'minhas-financas-telegram-contexto.json';

const ids = {};
let lastContext = '';

async function fileId(gfetch, name, initial) {
  if (ids[name]) return ids[name];
  const q = encodeURIComponent(`name = '${name}' and trashed = false`);
  const found = (await (await gfetch(`${DRIVE}?q=${q}&fields=files(id)&orderBy=modifiedTime desc`)).json()).files[0];
  if (found) return (ids[name] = found.id);
  const boundary = 'financas' + Math.random().toString(36).slice(2);
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: 'application/json' })}`
    + `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(initial)}\r\n--${boundary}--`;
  const res = await gfetch(`${UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  return (ids[name] = (await res.json()).id);
}

/** Importa o que o bot anotou e atualiza o contexto do bot. Devolve quantos lançamentos entraram. */
export async function syncBot(gfetch, api) {
  const [inboxId, contextId] = await Promise.all([fileId(gfetch, INBOX, { entries: [] }), fileId(gfetch, CONTEXT, {})]);
  const inbox = await (await gfetch(`${DRIVE}/${inboxId}?alt=media`))?.json().catch(() => null);
  let ctx = await api.get('/bot/context');
  const fresh = (inbox?.entries || []).filter(e => e.id > ctx.last_id);
  let created = 0;
  if (fresh.length) {
    ({ created } = await api.post('/bot/import', { entries: fresh }));
    ctx = await api.get('/bot/context');
  }
  const json = JSON.stringify(ctx);
  if (json !== lastContext) {
    await gfetch(`${UPLOAD}/${contextId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json });
    lastContext = json;
  }
  return created;
}
