// Testes das regras (porta de backend/tests/test_api.py). Rodar: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import * as D from '../frontend/js/core/dates.js';
import { createServer, wrap, checkBackup, upgrade } from '../frontend/js/core/server.js';

const SQL = await initSqlJs();
const schema = readFileSync(new URL('../frontend/sql/schema.sql', import.meta.url), 'utf8');
const seed = readFileSync(new URL('../frontend/sql/seed.sql', import.meta.url), 'utf8');
const TODAY = '2026-10-05';

function makeClient(sdb = new SQL.Database()) {
  const srv = createServer(wrap(sdb), schema, seed, () => TODAY);
  const call = (method, url, body) => {
    const r = srv.handle(method, url.replace(/^\/api/, ''), body);
    return { status: r.status, json: () => r.body };
  };
  return {
    sdb,
    get: u => call('GET', u),
    post: (u, b = {}) => call('POST', u, b),
    put: (u, b) => call('PUT', u, b),
    delete: u => call('DELETE', u),
  };
}

test('invoice month', () => {
  const cases = [
    ['2026-10-03', 5, 15, '2026-10'], ['2026-10-05', 5, 15, '2026-11'], ['2026-10-20', 28, 5, '2026-11'],
    ['2026-10-29', 28, 5, '2026-12'], ['2026-12-30', 28, 5, '2027-02'], ['2026-02-27', 31, 10, '2026-03'],
    ['2026-02-28', 31, 10, '2026-04'],
  ];
  for (const [d, c, due, exp] of cases) assert.equal(D.invoiceMonthFor(d, c, due), exp, d);
});

test('occurrences', () => {
  assert.deepEqual(D.occurrences('monthly', null, '2026-01-31', null, '2026-02'), ['2026-02-28']);
  assert.deepEqual(D.occurrences('monthly', 10, '2026-10-15', null, '2026-10'), []);
  assert.deepEqual(D.occurrences('yearly', 15, '2025-03-01', null, '2026-03'), ['2026-03-15']);
  assert.deepEqual(D.occurrences('yearly', 15, '2025-03-01', null, '2026-04'), []);
  assert.deepEqual(D.occurrences('weekly', null, '2026-10-02', null, '2026-10'),
    ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']);
  assert.deepEqual(D.occurrences('monthly', 5, '2026-01-01', '2026-03-01', '2026-04'), []);
});

test('business days', () => {
  assert.equal(D.easter(2027), '2027-03-28');
  assert.equal(D.nextBusinessDay('2026-10-10'), '2026-10-13'); // sáb -> (seg 12/10 feriado) -> ter
  assert.equal(D.nextBusinessDay('2027-02-08'), '2027-02-10'); // carnaval
  assert.equal(D.nextBusinessDay('2026-12-25'), '2026-12-28');
  assert.equal(D.nextBusinessDay('2026-10-14'), '2026-10-14');
  assert.equal(D.invoiceDueDate('2026-10', 10), '2026-10-13');
});

test('seed', () => {
  const c = makeClient();
  assert.equal(c.get('/api/accounts').json().length, 1);
  assert.ok(c.get('/api/categories').json().some(x => x.kind === 'income'));
});

test('expense and balance', () => {
  const c = makeClient();
  const acc = c.get('/api/accounts').json()[0];
  c.post('/api/transactions', { kind: 'income', description: 'Salário', amount: 500000, date: '2026-10-01', account_id: acc.id, paid: true });
  const tx = c.post('/api/transactions', { kind: 'expense', description: 'Mercado', amount: 25050, date: '2026-10-04', account_id: acc.id, paid: true }).json()[0];
  assert.equal(tx.paid, true);
  assert.equal(tx.paid_date, '2026-10-04');
  assert.equal(c.get('/api/accounts').json()[0].balance, 500000 - 25050);
  const s = c.get('/api/summary?month=2026-10').json();
  assert.equal(s.income.received, 500000);
  assert.equal(s.expense.paid, 25050);
  assert.equal(s.balance_forecast, 500000 - 25050);
});

test('card installments and invoice', () => {
  const c = makeClient();
  const acc = c.get('/api/accounts').json()[0];
  const card = c.post('/api/cards', { name: 'Nubank', credit_limit: 500000, closing_day: 28, due_day: 5, account_id: acc.id }).json();
  const txs = c.post('/api/transactions', { kind: 'expense', description: 'TV', amount: 100000, date: '2026-10-10', card_id: card.id, installments: 3 }).json();
  assert.deepEqual(txs.map(t => t.invoice_month), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(txs.map(t => t.amount), [33334, 33333, 33333]);
  assert.deepEqual(txs.map(t => t.installment_no), [1, 2, 3]);

  const cards = c.get('/api/cards').json();
  assert.equal(cards[0].used_limit, 100000);
  assert.equal(cards[0].current_invoice.month, '2026-11');

  const inv = c.get(`/api/cards/${card.id}/invoice?month=2026-11`).json();
  assert.equal(inv.total, 33334);
  assert.equal(inv.status, 'aberta');
  assert.equal(inv.closing_date, '2026-10-28');
  assert.equal(inv.due_date, '2026-11-05');

  const paid = c.post(`/api/cards/${card.id}/invoice/2026-11/pay`, {}).json();
  assert.ok(paid.paid);
  assert.equal(paid.paid_amount, 33334);
  assert.equal(c.get('/api/accounts').json()[0].balance, -33334);
  assert.equal(c.get('/api/cards').json()[0].used_limit, 66666);
  assert.equal(c.get('/api/transactions?month=2026-10').json()[0].paid, true);

  const s = c.get('/api/summary?month=2026-11').json();
  assert.equal(s.expense.total, 33334);
  assert.equal(s.expense.paid, 33334);
  assert.equal(c.delete(`/api/transactions/${txs[1].id}?scope=future`).json().deleted, 2);
});

test('recurrence generation, skip and reminders', () => {
  const c = makeClient();
  const acc = c.get('/api/accounts').json()[0];
  const rec = c.post('/api/recurrences', { description: 'Internet', amount: 9990, day: 7, start_date: '2026-10-01', account_id: acc.id, bill_type: 'boleto', reminder_days: 3 }).json();
  assert.equal(rec.next_date, '2026-10-07');
  assert.equal(rec.current.date, '2026-10-07');
  assert.deepEqual(c.get('/api/reminders').json().map(r => [r.description, r.days_until]), [['Internet', 2]]);

  const oct = c.get('/api/transactions?month=2026-10').json();
  assert.equal(oct.length, 1);
  const paid = c.post(`/api/transactions/${oct[0].id}/pay`, { amount: 10500 }).json();
  assert.ok(paid.paid);
  assert.equal(paid.amount, 10500);
  assert.deepEqual(c.get('/api/reminders').json(), []);

  // excluir uma ocorrência não deve recriá-la (07/11/2026 é sábado -> 09/11)
  const nov = c.get('/api/transactions?month=2026-11').json();
  assert.equal(nov[0].date, '2026-11-09');
  c.delete(`/api/transactions/${nov[0].id}`);
  assert.deepEqual(c.get('/api/transactions?month=2026-11').json(), []);
  assert.equal(c.get('/api/transactions?month=2026-12').json().length, 1);

  // editar a recorrência atualiza ocorrências futuras não pagas
  const { description, bill_type, day, start_date, account_id, reminder_days } = rec;
  c.put(`/api/recurrences/${rec.id}`, { description, bill_type, day, start_date, account_id, reminder_days, amount: 12000 });
  assert.equal(c.get('/api/transactions?month=2026-12').json()[0].amount, 12000);
  assert.equal(c.get('/api/transactions?month=2026-10').json()[0].amount, 10500);
});

test('recurrence due on business day (expenses only)', () => {
  const c = makeClient();
  c.post('/api/recurrences', { description: 'Aluguel', amount: 100000, day: 10, start_date: '2026-10-01' });
  c.post('/api/recurrences', { description: 'Salário', kind: 'income', amount: 100000, day: 10, start_date: '2026-10-01' });
  const txs = Object.fromEntries(c.get('/api/transactions?month=2026-10').json().map(t => [t.description, t]));
  assert.equal(txs.Aluguel.date, '2026-10-13');
  assert.equal(txs['Salário'].date, '2026-10-10');
});

test('installment amount mode', () => {
  const c = makeClient();
  const card = c.post('/api/cards', { name: 'C', closing_day: 1, due_day: 10 }).json();
  const txs = c.post('/api/transactions', { kind: 'expense', description: 'Geladeira', amount: 25000, date: '2026-10-05', card_id: card.id, installments: 4, amount_mode: 'installment' }).json();
  assert.deepEqual(txs.map(t => t.amount), [25000, 25000, 25000, 25000]);
});

test('settings', () => {
  const c = makeClient();
  const s = c.put('/api/settings', { reminder_days_default: 5 }).json();
  assert.equal(s.reminder_days_default, 5);
  assert.equal(s.notify_hour, 8);
});

test('daily grid', () => {
  const c = makeClient();
  const acc = c.get('/api/accounts').json()[0];
  c.put(`/api/accounts/${acc.id}`, { name: 'Conta', initial_balance: 100000 });
  const card = c.post('/api/cards', { name: 'C', closing_day: 28, due_day: 6 }).json();
  const post = b => c.post('/api/transactions', { description: 'x', account_id: acc.id, ...b });
  post({ kind: 'income', amount: 50000, date: '2026-10-06' });
  post({ kind: 'expense', amount: 20000, date: '2026-10-10' });
  post({ kind: 'expense', amount: 3000, date: '2026-10-10', nature: 'daily' });
  post({ kind: 'expense', amount: 10000, date: '2026-10-15', nature: 'saving' });
  post({ kind: 'income', amount: 4000, date: '2026-10-20', nature: 'saving' });
  post({ kind: 'income', amount: 999, date: '2026-10-21', nature: 'daily' });
  post({ kind: 'expense', amount: 7000, date: '2026-09-20', card_id: card.id });
  post({ kind: 'expense', amount: 500, date: '2026-09-30' });

  const g = c.get('/api/daily?start=2026-10&months=2').json();
  assert.equal(g.opening_balance, 99500);
  const oct = g.months[0];
  const day = Object.fromEntries(oct.days.map(d => [d.date.slice(8), d]));
  assert.equal(day['06'].income, 50000);
  assert.equal(day['06'].card, 7000);
  assert.equal(day['06'].balance, 99500 + 50000 - 7000);
  assert.equal(day['10'].bills, 20000);
  assert.equal(day['10'].daily, 3000);
  assert.equal(day['15'].savings, 10000);
  assert.equal(day['20'].savings, -4000);
  assert.equal(day['21'].income, 999);
  assert.equal(oct.totals.savings, 6000);
  assert.equal(oct.end_balance, 99500 + 50000 + 999 - 7000 - 20000 - 3000 - 6000);
  assert.equal(oct.days.length, 31);
  assert.equal(g.months[1].days[0].balance, oct.end_balance);
});

test('upcoming', () => {
  const c = makeClient();
  c.post('/api/recurrences', { description: 'Aluguel', amount: 100000, day: 20, start_date: '2026-10-01', reminder_days: 5 });
  assert.deepEqual(c.get('/api/reminders').json(), []);
  assert.deepEqual(c.get('/api/upcoming?days=60').json().map(u => [u.due_date, u.remind_on, u.remind_days]),
    [['2026-10-20', '2026-10-15', 5], ['2026-11-23', '2026-11-18', 5]]); // 20/11 é feriado
});

test('reset', () => {
  const c = makeClient();
  c.post('/api/cards', { name: 'C', closing_day: 1, due_day: 10 });
  c.put('/api/settings', { reminder_days_default: 7 });
  assert.equal(c.post('/api/reset', { confirm: 'sim' }).status, 400);
  assert.deepEqual(c.post('/api/reset', { confirm: 'APAGAR' }).json(), { ok: true });
  assert.deepEqual(c.get('/api/cards').json(), []);
  assert.equal(c.get('/api/accounts').json().length, 1);
  assert.equal(c.get('/api/categories').json().length, 16);
  assert.equal(c.get('/api/settings').json().reminder_days_default, 7);
});

test('failed mutation is rolled back', () => {
  const c = makeClient();
  const r = c.post('/api/transactions', { kind: 'expense', description: 'x', amount: 1, date: '2026-10-05', category_id: 999 });
  assert.equal(r.status, 404);
  assert.deepEqual(c.get('/api/transactions?month=2026-10').json(), []);
});

test('opens a database created by the Python backend (v1 -> v4)', () => {
  const sdb = new SQL.Database();
  const db = wrap(sdb);
  db.exec(schema.replace(/,\s*nature\s+TEXT/g, '')); // formato antigo, sem a coluna nature
  db.exec(seed);
  db.exec('PRAGMA user_version = 1');
  checkBackup(db);
  upgrade(db, schema, seed, TODAY);
  assert.equal(db.scalar('PRAGMA user_version'), 4);
  assert.ok(db.all('PRAGMA table_info(recurrences)').some(c => c.name === 'due_shift'));
  assert.ok(db.all('PRAGMA table_info(transactions)').some(c => c.name === 'nature'));
  const c = makeClient(sdb);
  assert.equal(c.get('/api/categories').json().length, 16); // não duplica o seed
});

test('salary on the last day of the month, anticipated to the previous business day', () => {
  const c = makeClient();
  const r = c.post('/api/recurrences', { description: 'Salário', kind: 'income', amount: 630000, day: 31,
    start_date: '2026-10-01', due_shift: 'previous' }).json();
  assert.equal(r.due_shift, 'previous');
  assert.equal(r.next_date, '2026-10-30'); // 31/10/2026 é sábado
  const on = m => c.get(`/api/transactions?month=${m}`).json().find(t => t.description === 'Salário').date;
  assert.equal(on('2026-10'), '2026-10-30');
  assert.equal(on('2026-11'), '2026-11-30'); // segunda
  assert.equal(on('2027-01'), '2027-01-29'); // 31/01/2027 é domingo
  assert.equal(on('2027-02'), '2027-02-26'); // 28/02/2027 é domingo
  // despesa pode manter a data
  c.post('/api/recurrences', { description: 'Aluguel', amount: 1, day: 10, start_date: '2026-10-01', due_shift: 'none' });
  assert.equal(c.get('/api/transactions?month=2026-10').json().find(t => t.description === 'Aluguel').date, '2026-10-10');
});
