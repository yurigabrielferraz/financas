// Onde ficam os dados: um arquivo SQLite no Google Drive (ou só neste navegador, modo local).
// O banco roda em memória (sql.js); cada alteração é enviada ao Drive ~1,5 s depois.
// Conflito: antes de enviar, compara o md5 do arquivo no Drive com o da última sincronização.
// ponytail: envia o arquivo inteiro (KBs). Sincronização por registro só se o arquivo ficar grande.
import { createServer, wrap, checkBackup } from './core/server.js';
import { GOOGLE_CLIENT_ID } from './config.js';

const SQLJS = 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/';
const GIS = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const FILE_NAME = 'minhas-financas.db';

const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sem storage */ } },
};

class AuthError extends Error {}

let SQL, schemaSql, seedSql, pushTimer, saveTimer, tokenClient;

export const store = {
  server: null,
  /** 'drive' | 'local' | null (ainda não escolhido) */
  mode: ls.get('storage'),
  /** idle | syncing | ok | offline | auth | conflict */
  status: 'idle',
  dirty: false,
  baseMd5: null,
  fileId: ls.get('driveFileId'),
  onStatus: () => {},
  onReload: () => {},
  /** Deve devolver 'drive' (descartar o que está aqui) ou 'here' (sobrescrever o Drive). */
  onConflict: async () => 'here',

  get driveConfigured() { return !!GOOGLE_CLIENT_ID; },

  /** Carrega o motor SQLite e abre os dados. Retorna 'ready' | 'choose' | 'connect' | 'nofile'. */
  async init() {
    if (!SQL) {
      await loadScript(SQLJS + 'sql-wasm.js');
      SQL = await window.initSqlJs({ locateFile: f => SQLJS + f });
      [schemaSql, seedSql] = await Promise.all(['sql/schema.sql', 'sql/seed.sql'].map(u => fetch(u).then(r => r.text())));
    }
    if (this.mode === 'local') {
      this.open(await idb.get('db'));
      setStatus('ok');
      return 'ready';
    }
    if (this.mode === 'drive') {
      if (!validToken()) return 'connect';
      return this.openDrive();
    }
    return 'choose';
  },

  open(bytes) {
    const sdb = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
    if (bytes) checkBackup(wrap(sdb));
    this.server = createServer(wrap(sdb), schemaSql, seedSql);
  },

  exportBytes() {
    const db = this.server.db;
    const bytes = db.raw.export();
    db.exec('PRAGMA foreign_keys = ON'); // export() reabre o banco e zera os pragmas
    return bytes;
  },

  // ---------------------------------------------------------------- escolha do armazenamento

  useLocal() {
    this.mode = 'local';
    ls.set('storage', 'local');
  },

  /** Precisa ser chamado a partir de um clique (abre o login do Google). */
  async connect() {
    await requestToken();
    this.mode = 'drive';
    ls.set('storage', 'drive');
    return this.openDrive();
  },

  forget() {
    ['storage', 'driveFileId', 'gtoken'].forEach(k => ls.set(k, null));
  },

  // ---------------------------------------------------------------- Google Drive

  async openDrive() {
    setStatus('syncing');
    try {
      const f = await findFile();
      if (!f) { setStatus('idle'); return 'nofile'; }
      this.open(await download(f.id));
      this.fileId = f.id;
      this.baseMd5 = f.md5Checksum;
      ls.set('driveFileId', f.id);
      setStatus('ok');
      return 'ready';
    } catch (e) {
      if (e instanceof AuthError) return 'connect';
      throw e;
    }
  },

  /** Cria o arquivo no Drive: vazio (dados iniciais) ou a partir de um backup .db. */
  async createDriveFile(bytes = null) {
    this.open(bytes);
    const f = await createFile(this.exportBytes());
    this.fileId = f.id;
    this.baseMd5 = f.md5Checksum;
    ls.set('driveFileId', f.id);
    setStatus('ok');
  },

  // ---------------------------------------------------------------- sincronização

  /** Chamado após cada alteração feita pelo usuário. */
  markDirty() {
    this.dirty = true;
    if (this.mode === 'local') {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { idb.set('db', this.exportBytes()); this.dirty = false; }, 300);
      return;
    }
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => this.sync(), 1500);
  },

  /** Envia (se houver alteração aqui) ou baixa (se mudou no Drive). Pergunta em caso de conflito. */
  async sync() {
    if (this.mode !== 'drive' || !this.fileId || this.status === 'syncing') return;
    clearTimeout(pushTimer);
    setStatus('syncing');
    try {
      const remote = await meta(this.fileId);
      const changedThere = remote.md5Checksum !== this.baseMd5;
      let action = this.dirty ? 'push' : changedThere ? 'pull' : null;
      if (this.dirty && changedThere) {
        setStatus('conflict');
        action = (await this.onConflict()) === 'drive' ? 'pull' : 'push';
        setStatus('syncing');
      }
      if (action === 'push') {
        this.dirty = false;
        this.baseMd5 = (await upload(this.fileId, this.exportBytes())).md5Checksum;
      } else if (action === 'pull') {
        this.open(await download(this.fileId));
        this.baseMd5 = remote.md5Checksum;
        this.dirty = false;
        this.onReload();
      }
      setStatus('ok');
    } catch (e) {
      setStatus(e instanceof AuthError ? 'auth' : 'offline');
    }
  },

  /** Reconecta (precisa de clique) e sincroniza. */
  async reconnect() {
    await requestToken();
    await this.sync();
  },

  /** Substitui todos os dados por um backup .db (valida antes). */
  async importBytes(bytes) {
    const before = this.server ? this.exportBytes() : null;
    this.open(bytes); // lança erro se não for um backup válido
    if (this.mode === 'local' && before) await idb.set('db-antes-de-importar', before);
    this.markDirty();
    if (this.mode === 'drive') await this.sync();
  },
};

function setStatus(s) {
  store.status = s;
  store.onStatus(s);
}

// ------------------------------------------------------------------ Google: login e Drive REST

function validToken() {
  try {
    const t = JSON.parse(ls.get('gtoken'));
    return t && t.exp > Date.now() + 60000 ? t.access_token : null;
  } catch { return null; }
}

async function requestToken() {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google Client ID não configurado (js/config.js)');
  if (!window.google?.accounts?.oauth2) await loadScript(GIS);
  return new Promise((resolve, reject) => {
    tokenClient ??= google.accounts.oauth2.initTokenClient({ client_id: GOOGLE_CLIENT_ID, scope: SCOPE, callback: () => {} });
    tokenClient.callback = r => {
      if (r.error) return reject(new Error(r.error_description || r.error));
      // ponytail: token de 1 h guardado neste navegador; depois disso, um toque em "reconectar"
      ls.set('gtoken', JSON.stringify({ access_token: r.access_token, exp: Date.now() + r.expires_in * 1000 }));
      resolve(r.access_token);
    };
    tokenClient.error_callback = e => reject(new Error(e.message || e.type));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function driveFetch(url, opts = {}) {
  const token = validToken();
  if (!token) throw new AuthError('Sessão do Google expirada');
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });
  if (res.status === 401) { ls.set('gtoken', null); throw new AuthError('Sessão do Google expirada'); }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Google Drive: ${res.status} ${await res.text()}`);
  return res;
}

const meta = async id => (await driveFetch(`${DRIVE}/${id}?fields=id,name,md5Checksum`))?.json() ?? Promise.reject(new Error('Arquivo não encontrado no Drive'));

async function findFile() {
  if (store.fileId) {
    const f = await driveFetch(`${DRIVE}/${store.fileId}?fields=id,name,md5Checksum,trashed`).then(r => r?.json());
    if (f && !f.trashed) return f;
  }
  const q = encodeURIComponent(`name = '${FILE_NAME}' and trashed = false`);
  const list = await (await driveFetch(`${DRIVE}?q=${q}&fields=files(id,name,md5Checksum)&orderBy=modifiedTime desc`)).json();
  return list.files[0] ?? null;
}

const download = async id => (await driveFetch(`${DRIVE}/${id}?alt=media`)).arrayBuffer();

const upload = async (id, bytes) => (await driveFetch(`${UPLOAD}/${id}?uploadType=media&fields=id,md5Checksum`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
})).json();

async function createFile(bytes) {
  const boundary = 'financas' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name: FILE_NAME, mimeType: 'application/x-sqlite3', description: 'Dados do app Minhas Finanças' }),
    `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, bytes, `\r\n--${boundary}--`,
  ]);
  return (await driveFetch(`${UPLOAD}?uploadType=multipart&fields=id,md5Checksum`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src, async: true, onload: resolve });
    s.onerror = () => reject(new Error(`Falha ao carregar ${src} (sem internet?)`));
    document.head.append(s);
  });
}

// ------------------------------------------------------------------ IndexedDB (modo local)

const idb = {
  open: () => new Promise((resolve, reject) => {
    const r = indexedDB.open('financas', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }),
  async get(k) {
    const db = await this.open();
    return new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); });
  },
  async set(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
};
