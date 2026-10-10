// Leitor da fatura Itaú com uma fatura sintética (dados inventados) no mesmo layout do PDF real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { parseItau, parseMoneyBR } from '../frontend/js/core/itau.js';
import { createServer, wrap } from '../frontend/js/core/server.js';

// item de texto: largura aproximada (5pt por caractere), como o pdf.js entrega
const t = (s, x, y) => ({ s, x, y, w: s.length * 5 });
/** Linha de lançamento + linha de categoria logo abaixo, numa coluna que começa em `x`. */
const tx = (x, y, date, desc, value, cat) => [
  t(date, x, y), t(desc, x + 28, y), t(value, x + 180 - value.length * 5, y),
  ...(cat ? [t(cat, x + 28, y - 9)] : []),
];

const page1 = [
  t('Vencimento: 06/10/2026', 230, 668), t('Total desta fatura', 365, 668), t('1.234,56', 530, 668),
  t('Cartão', 69, 611), t('4831.XXXX.XXXX.1234', 96, 611),
];
const L = 133, R = 351; // duas colunas
const page2 = [
  // coluna esquerda: pagamentos (ignorar) e depois compras
  t('Pagamentos efetuados', L, 719), t('DATA', L, 708), t('VALOR EM R$', L + 156, 708),
  ...tx(L, 699, '01/09', 'Pagamento via conta', '-999,00'),
  t('Lançamentos: compras e saques', L, 660), t('DATA', L, 639), t('ESTABELECIMENTO', L + 28, 639), t('VALOR EM R$', L + 156, 639),
  ...tx(L, 630, '15/12', 'LOJA ANTIGA 10/12', '100,00', 'eletronicos SAO PAULO'), // compra do ano anterior
  ...tx(L, 611, '03/09', 'DL', '20,00', 'transporte Sao Paulo'),
  // coluna direita, com alturas intercaladas
  t('Lançamentos: compras e saques', R, 719), t('DATA', R, 708), t('VALOR EM R$', R + 156, 708),
  ...tx(R, 703, '20/09', 'PADARIA X', '10,00', 'restaurante RIO'),
  ...tx(R, 626, '21/09', 'PADARIA X', '10,00', 'restaurante RIO'), // mesma compra 2x no dia seguinte
  ...tx(R, 607, '21/09', 'PADARIA X', '10,00', 'restaurante RIO'), // e 2x no mesmo dia
  ...tx(R, 588, '22/09', 'ESTORNO LOJA', '-5,00', 'outros RIO'),
  ...tx(R, 569, '23/09', 'MOVEIS SA 01/03', '300,00', 'outros RIO'),
];
const page3 = [
  t('Lançamentos: produtos e serviços', 143, 464), t('DATA', 143, 454), t('VALOR EM R$', 292, 454),
  ...tx(143, 444, '17/09', 'SEG CARTAO PROTEGIDO', '15,52'),
  t('Total dos lançamentos atuais', 143, 398), t('1.234,56', 305, 398),
  t('Compras parceladas - próximas faturas', 143, 370), t('DATA', 143, 360), t('VALOR EM R$', 292, 360),
  ...tx(143, 350, '23/09', 'MOVEIS SA 02/03', '300,00'), // ignorar
];

test('money', () => {
  assert.equal(parseMoneyBR('4.890,31'), 489031);
  assert.equal(parseMoneyBR('-3.828,52'), -382852);
  assert.equal(parseMoneyBR('abc'), null);
});

test('parse statement', () => {
  const st = parseItau([page1, page2, page3]);
  assert.equal(st.dueDate, '2026-10-06');
  assert.equal(st.last4, '1234');
  assert.equal(st.launchesTotal, 123456);
  const d = st.items.map(i => [i.date, i.description, i.amount, i.installmentNo, i.installmentTotal, i.itauCategory]);
  assert.deepEqual(d, [
    ['2025-12-15', 'LOJA ANTIGA', 10000, 10, 12, 'eletronicos'],
    ['2026-09-03', 'DL', 2000, null, null, 'transporte'],
    ['2026-09-17', 'SEG CARTAO PROTEGIDO', 1552, null, null, null],
    ['2026-09-20', 'PADARIA X', 1000, null, null, 'restaurante'],
    ['2026-09-21', 'PADARIA X', 1000, null, null, 'restaurante'],
    ['2026-09-21', 'PADARIA X', 1000, null, null, 'restaurante'],
    ['2026-09-22', 'ESTORNO LOJA', -500, null, null, 'outros'],
    ['2026-09-23', 'MOVEIS SA', 30000, 1, 3, 'outros'],
  ]);
});

test('import: installments, refunds, identical items, re-import', async () => {
  const SQL = await initSqlJs();
  const sql = f => readFileSync(new URL(`../frontend/sql/${f}`, import.meta.url), 'utf8');
  const srv = createServer(wrap(new SQL.Database()), sql('schema.sql'), sql('seed.sql'), () => '2026-10-10');
  const h = (m, u, b) => srv.handle(m, u, b).body;
  const card = h('POST', '/cards', { name: 'Itaú', closing_day: 30, due_day: 6 });
  const st = parseItau([page1, page2, page3]);

  const pv = h('POST', `/cards/${card.id}/import/preview`, st);
  assert.equal(pv.month, '2026-10');
  assert.ok(pv.items.every(i => i.status === 'new'));
  assert.equal(pv.items.find(i => i.description === 'DL').category_id, h('GET', '/categories').find(c => c.name === 'Transporte').id);

  h('POST', `/cards/${card.id}/import`, { month: pv.month, items: pv.items });
  const oct = h('GET', `/cards/${card.id}/invoice?month=2026-10`);
  assert.equal(oct.total, 10000 + 2000 + 3000 - 500 + 30000 + 1552);
  assert.equal(oct.items.filter(i => i.description === 'PADARIA X').length, 3);
  const refund = oct.items.find(i => i.description === 'ESTORNO LOJA');
  assert.equal(refund.kind, 'income');
  // parcelas seguintes nas próximas faturas (LOJA ANTIGA 11-12/12, MOVEIS 2-3/3)
  assert.equal(h('GET', `/cards/${card.id}/invoice?month=2026-11`).total, 10000 + 30000);
  assert.equal(h('GET', `/cards/${card.id}/invoice?month=2026-12`).total, 10000 + 30000);
  assert.equal(h('GET', `/cards/${card.id}/invoice?month=2027-01`).total, 0);

  // importar de novo não duplica
  const pv2 = h('POST', `/cards/${card.id}/import/preview`, st);
  assert.ok(pv2.items.every(i => i.status === 'exists'));
  assert.deepEqual(h('POST', `/cards/${card.id}/import`, { month: pv2.month, items: pv2.items }), { created: 0, updated: 0, skipped: 8 });

  // categoria aprendida: o que o usuário escolher para um estabelecimento vale nas próximas
  const lazer = h('GET', '/categories').find(c => c.name === 'Lazer').id;
  const pad = oct.items.find(i => i.description === 'PADARIA X');
  h('PUT', `/transactions/${pad.id}`, { ...pad, category_id: lazer });
  assert.equal(h('POST', `/cards/${card.id}/import/preview`, st).items.find(i => i.description === 'PADARIA X').category_id, lazer);
});

test('import: edited names and categories are remembered', async () => {
  const SQL = await initSqlJs();
  const sql = f => readFileSync(new URL(`../frontend/sql/${f}`, import.meta.url), 'utf8');
  const srv = createServer(wrap(new SQL.Database()), sql('schema.sql'), sql('seed.sql'), () => '2026-10-10');
  const h = (m, u, b) => srv.handle(m, u, b).body;
  const card = h('POST', '/cards', { name: 'Itaú', closing_day: 30, due_day: 6 });
  const st = parseItau([page1, page2, page3]);
  const lazer = h('GET', '/categories').find(c => c.name === 'Lazer').id;

  const pv = h('POST', `/cards/${card.id}/import/preview`, st);
  assert.equal(pv.items.find(i => i.description === 'DL').name, 'DL');
  const items = pv.items.map(i => (i.description === 'DL' ? { ...i, name: 'Uber', category_id: lazer }
    : i.description === 'MOVEIS SA' ? { ...i, name: 'Sofá' } : i));
  h('POST', `/cards/${card.id}/import`, { month: pv.month, items });

  const oct = h('GET', `/cards/${card.id}/invoice?month=2026-10`).items;
  assert.ok(oct.some(t => t.description === 'Uber' && t.category_id === lazer));
  assert.equal(h('GET', `/cards/${card.id}/invoice?month=2026-11`).items.find(t => t.installment_total === 3).description, 'Sofá');

  // próxima importação: nome e categoria sugeridos; renomear não quebra a detecção de duplicados
  const pv2 = h('POST', `/cards/${card.id}/import/preview`, st);
  const dl = pv2.items.find(i => i.description === 'DL');
  assert.equal(dl.name, 'Uber');
  assert.equal(dl.category_id, lazer);
  assert.ok(pv2.items.every(i => i.status === 'exists'));
});
