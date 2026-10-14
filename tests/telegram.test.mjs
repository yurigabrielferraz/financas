// Bot do Telegram: importação no app e o script do Apps Script rodando com Telegram/Gemini/Drive falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import initSqlJs from 'sql.js';
import { createServer, wrap } from '../frontend/js/core/server.js';

const SQL = await initSqlJs();
const sql = f => readFileSync(new URL(`../frontend/sql/${f}`, import.meta.url), 'utf8');

test('app: bot context and import', () => {
  const srv = createServer(wrap(new SQL.Database()), sql('schema.sql'), sql('seed.sql'), () => '2026-10-12');
  const h = (m, u, b) => srv.handle(m, u, b).body;
  const card = h('POST', '/cards', { name: 'Itaú', closing_day: 30, due_day: 6 });
  const ctx = h('GET', '/bot/context');
  assert.equal(ctx.last_id, 0);
  assert.ok(ctx.categories.expense.includes('Transporte'));
  assert.deepEqual(ctx.cards, ['Itaú']);

  const entries = [
    { id: 10, kind: 'expense', description: 'Uber', amount: 2548, date: '2026-10-12', category: 'transporte', payment: null, text: 'gastei 25,48 de uber' },
    { id: 11, kind: 'expense', description: 'Mercado', amount: 13290, date: '2026-10-11', category: 'Mercado', payment: 'itaú' },
    { id: 11.1, kind: 'expense', description: 'Lixo', amount: 0, date: '2026-10-11' }, // inválido: pulado
  ];
  assert.deepEqual(h('POST', '/bot/import', { entries }), { created: 2, last_id: 11.1 });
  const txs = h('GET', '/transactions?month=2026-10');
  const uber = txs.find(t => t.description === 'Uber');
  assert.equal(uber.category_id, h('GET', '/categories').find(c => c.name === 'Transporte').id);
  assert.equal(uber.paid, true);
  assert.equal(uber.nature, 'daily');
  assert.equal(uber.account_id, h('GET', '/accounts')[0].id);
  const mercado = txs.find(t => t.description === 'Mercado');
  assert.equal(mercado.card_id, card.id);
  assert.equal(mercado.invoice_month, '2026-11');
  // reenviar não duplica
  assert.equal(h('POST', '/bot/import', { entries }).created, 0);
  assert.equal(h('GET', '/bot/context').last_id, 11.1);
  assert.ok(h('GET', '/bot/context').examples.some(x => x.description === 'Uber' && x.category === 'Transporte'));
});

test('app: bot uses the default payment from settings', () => {
  const srv = createServer(wrap(new SQL.Database()), sql('schema.sql'), sql('seed.sql'), () => '2026-10-12');
  const h = (m, u, b) => srv.handle(m, u, b).body;
  const mp = h('POST', '/accounts', { name: 'MercadoPago' });
  h('PUT', '/settings', { default_source: `a:${mp.id}` });
  h('POST', '/bot/import', { entries: [
    { id: 1, kind: 'expense', description: 'Uber', amount: 2548, date: '2026-10-12', category: 'Transporte', payment: null },
    { id: 2, kind: 'expense', description: 'Pão', amount: 900, date: '2026-10-12', category: null, payment: 'conta principal' },
  ] });
  const txs = h('GET', '/transactions?month=2026-10');
  assert.equal(txs.find(t => t.description === 'Uber').account_id, mp.id);
  assert.notEqual(txs.find(t => t.description === 'Pão').account_id, mp.id);
});

/** Roda o telegram-bot.gs num sandbox com os serviços do Apps Script simulados. */
function appsScript({ updates, gemini }) {
  const props = { TELEGRAM_TOKEN: 't', GEMINI_KEY: 'g', CHAT_ID: '42', OFFSET: '0' };
  const files = {
    'minhas-financas-telegram.json': JSON.stringify({ entries: [] }),
    'minhas-financas-telegram-contexto.json': JSON.stringify({ last_id: 0, categories: { expense: ['Transporte'], income: ['Salário'] }, accounts: ['Conta principal'], cards: [] }),
  };
  const sent = [];
  const prompts = [];
  const file = name => ({
    isTrashed: () => false, getLastUpdated: () => 0,
    getBlob: () => ({ getDataAsString: () => files[name] }),
    setContent: c => { files[name] = c; },
  });
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, setProperties: o => Object.assign(props, o),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    DriveApp: { getFilesByName: name => { let done = !files[name]; return { hasNext: () => !done, next: () => { done = true; return file(name); } }; } },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : 'segunda, ' + d.toISOString().slice(0, 10)) },
    UrlFetchApp: { fetch: (url, opts) => {
      const body = JSON.parse(opts.payload);
      if (url.includes('generativelanguage')) {
        prompts.push(body.contents[0].parts[0].text);
        const out = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ itens: gemini }) }] } }] });
        return { getResponseCode: () => 200, getContentText: () => out };
      }
      const method = url.split('/').pop();
      const result = method === 'getUpdates' ? updates.filter(u => u.update_id >= (body.offset || 0)) : (sent.push(body), {});
      return { getContentText: () => JSON.stringify({ ok: true, result }) };
    } },
  };
  vm.runInNewContext(readFileSync(new URL('../frontend/telegram-bot.gs', import.meta.url), 'utf8'), sandbox);
  return { run: () => sandbox.verificar(), files, sent, prompts, props };
}

const today = new Date().toISOString().slice(0, 10);

test('apps script: notes the expense and replies', () => {
  const bot = appsScript({
    updates: [
      { update_id: 5, message: { chat: { id: 42 }, text: 'gastei 25,48 reais de uber' } },
      { update_id: 6, message: { chat: { id: 99 }, text: 'gastei 1000 de golpe' } }, // outro chat: ignorado
    ],
    gemini: [{ tipo: 'saida', descricao: 'Uber', valor: 25.48, data: today, categoria: 'Transporte', pagamento: null }],
  });
  bot.run();
  const inbox = JSON.parse(bot.files['minhas-financas-telegram.json']).entries;
  assert.equal(inbox.length, 1);
  assert.deepEqual({ ...inbox[0], at: undefined }, { id: 5, at: undefined, text: 'gastei 25,48 reais de uber', kind: 'expense',
    description: 'Uber', amount: 2548, date: today, category: 'Transporte', payment: null });
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].chat_id, 42);
  assert.match(bot.sent[0].text, /Uber — R\$ 25,48 · Transporte · hoje/);
  assert.match(bot.prompts[0], /Categorias de saída: Transporte/);
  assert.equal(bot.props.OFFSET, '7');

  bot.run(); // nada novo
  assert.equal(bot.sent.length, 1);
});

test('apps script: undo', () => {
  const bot = appsScript({
    updates: [
      { update_id: 5, message: { chat: { id: 42 }, text: 'almoço 42' } },
      { update_id: 6, message: { chat: { id: 42 }, text: 'desfazer' } },
    ],
    gemini: [{ tipo: 'saida', descricao: 'Almoço', valor: 42, data: today, categoria: 'Transporte', pagamento: null }],
  });
  bot.run();
  assert.equal(JSON.parse(bot.files['minhas-financas-telegram.json']).entries.length, 0);
  assert.match(bot.sent[1].text, /Removido: Almoço — R\$ 42,00/);
});
