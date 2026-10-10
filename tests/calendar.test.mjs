// Sincronização com o Google Agenda contra uma API falsa em memória.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvents, eventId, reminderMinutes, syncCalendar } from '../frontend/js/calendar.js';

const items = [
  { type: 'transaction', id: 7, description: 'Aluguel', amount: 160000, due_date: '2026-11-05', remind_days: 3 },
  { type: 'invoice', card_id: 2, month: '2026-11', description: 'Fatura Itaú', amount: 332225, due_date: '2026-11-06', remind_days: 0 },
];

/** API falsa: guarda eventos; apagados ficam "cancelled" e o id não pode ser reinserido (como no Google). */
function fakeApi() {
  const events = new Map();
  const calls = [];
  const gfetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(method);
    const id = /\/events\/([^/?]+)/.exec(url)?.[1];
    const ok = body => ({ json: async () => body });
    if (method === 'GET') return ok({ items: [...events.values()].filter(e => e.status !== 'cancelled') });
    if (method === 'POST') {
      const ev = JSON.parse(opts.body);
      if (events.has(ev.id)) throw Object.assign(new Error('409'), { status: 409 });
      events.set(ev.id, { ...ev, status: 'confirmed' });
      return ok(ev);
    }
    if (method === 'PUT') { events.set(id, { status: 'confirmed', ...JSON.parse(opts.body) }); return ok({}); }
    if (method === 'DELETE') { events.get(id).status = 'cancelled'; return ok({}); }
  };
  return { gfetch, events, calls, live: () => [...events.values()].filter(e => e.status !== 'cancelled') };
}

test('buildEvents', () => {
  const [bill, inv] = buildEvents(items, 9, 'https://x/');
  assert.match(bill.id, /^[a-v0-9]{5,1024}$/); // formato exigido pela API
  assert.equal(bill.id, eventId('tx:7'));
  assert.deepEqual([bill.start, bill.end], [{ date: '2026-11-05' }, { date: '2026-11-06' }]); // dia inteiro
  // 3 dias antes às 9h e 1 dia antes às 9h (minutos antes da meia-noite do dia do vencimento)
  assert.deepEqual(bill.reminders.overrides.map(o => o.minutes), [3 * 1440 - 540, 1440 - 540]);
  assert.deepEqual(inv.reminders.overrides.map(o => o.minutes), [0]);
  assert.ok(inv.summary.startsWith('💳 Fatura Itaú'));
  assert.notEqual(buildEvents([{ ...items[0], amount: 1 }], 9, '')[0].extendedProperties.private.sig, bill.extendedProperties.private.sig);
});

test('reminderMinutes', () => {
  assert.deepEqual(reminderMinutes(1, 8), [1440 - 480]);
  assert.deepEqual(reminderMinutes(30, 8), [40320, 960]); // limite de 4 semanas da API
});

test('sync: create, no-op, update, remove paid, restore deleted id', async () => {
  const api = fakeApi();
  let r = await syncCalendar(api.gfetch, 'cal', buildEvents(items, 9, ''));
  assert.deepEqual([r.created, r.updated, r.removed], [2, 0, 0]);

  api.calls.length = 0;
  r = await syncCalendar(api.gfetch, 'cal', buildEvents(items, 9, ''));
  assert.deepEqual([r.created, r.updated, r.removed], [0, 0, 0]);
  assert.deepEqual(api.calls, ['GET']); // nada mudou: só lista

  r = await syncCalendar(api.gfetch, 'cal', buildEvents([{ ...items[0], amount: 170000 }, items[1]], 9, ''));
  assert.equal(r.updated, 1);
  assert.ok(api.live().some(e => e.summary.includes('1.700,00')));

  r = await syncCalendar(api.gfetch, 'cal', buildEvents([items[1]], 9, '')); // aluguel pago
  assert.equal(r.removed, 1);
  assert.equal(api.live().length, 1);

  r = await syncCalendar(api.gfetch, 'cal', buildEvents(items, 9, '')); // desmarcou o pagamento
  assert.equal(r.created, 1);
  assert.equal(api.live().length, 2);
});
