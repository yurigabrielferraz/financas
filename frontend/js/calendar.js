// Lembretes no Google Agenda: cada saída/conta e cada vencimento de fatura não pagos viram um evento
// numa agenda própria ("Minhas Finanças"). Pago/excluído -> evento removido; valor/data mudou -> atualizado.
// Escopo calendar.app.created: o app só enxerga as agendas que ele mesmo criou.
import { fmtMoney, fmtDateFull } from './utils.js';

export const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TZ = 'America/Sao_Paulo';

/** ID fixo por lançamento/fatura (a API aceita a-v e 0-9): sincronizar de novo não duplica. */
export const eventId = key => 'fin' + [...new TextEncoder().encode(key)].map(b => b.toString(16).padStart(2, '0')).join('');

/** Dia seguinte (AAAA-MM-DD): fim exclusivo de um evento de dia inteiro. */
const nextDay = iso => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/**
 * Lembretes de um evento de dia inteiro: a API conta os minutos antes da meia-noite do dia do evento.
 * N dias antes às `hour`h e, se N > 1, também 1 dia antes às `hour`h. N = 0: à meia-noite do dia
 * (a API não aceita "no próprio dia às Xh" para evento de dia inteiro).
 */
export function reminderMinutes(days, hour) {
  const at = d => Math.min(40320, d * 1440 - hour * 60); // máximo da API: 4 semanas
  if (days <= 0) return [0];
  return days > 1 ? [at(days), at(1)] : [at(1)];
}

/** Eventos de dia inteiro, na data do vencimento, a partir de /upcoming. */
export function buildEvents(items, hour, siteUrl) {
  return items.map(it => {
    const invoice = it.type === 'invoice';
    const key = invoice ? `inv:${it.card_id}:${it.month}` : `tx:${it.id}`;
    const summary = `${invoice ? '💳' : '💸'} ${it.description} — ${fmtMoney(it.amount)}`;
    const minutes = reminderMinutes(it.remind_days, hour);
    return {
      id: eventId(key),
      summary,
      description: `${invoice ? 'Fatura do cartão' : 'Conta a pagar'}: ${fmtMoney(it.amount)}\nVencimento: ${fmtDateFull(it.due_date)}\n\n${siteUrl}`,
      start: { date: it.due_date },
      end: { date: nextDay(it.due_date) },
      transparency: 'transparent',
      colorId: invoice ? '9' : '11',
      reminders: { useDefault: false, overrides: minutes.map(m => ({ method: 'popup', minutes: m })) },
      extendedProperties: { private: { app: 'financas', sig: ['allday', summary, it.due_date, minutes.join(',')].join('|') } },
    };
  });
}

/** Garante a agenda "Minhas Finanças"; devolve o id (cria se não existir mais). */
export async function ensureCalendar(gfetch, id) {
  if (id && await gfetch(`${CAL}/calendars/${encodeURIComponent(id)}`)) return id;
  const res = await gfetch(`${CAL}/calendars`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: 'Minhas Finanças', description: 'Vencimentos criados pelo app Minhas Finanças', timeZone: TZ }),
  });
  return (await res.json()).id;
}

export async function deleteCalendar(gfetch, id) {
  if (id) await gfetch(`${CAL}/calendars/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Deixa a agenda igual à lista desejada. Só toca no que mudou. */
export async function syncCalendar(gfetch, calendarId, desired) {
  const base = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`;
  const existing = new Map(); // id -> assinatura
  let pageToken = '';
  do {
    const r = await (await gfetch(`${base}?maxResults=2500${pageToken ? `&pageToken=${pageToken}` : ''}`)).json();
    for (const e of r.items || []) existing.set(e.id, e.extendedProperties?.private?.sig);
    pageToken = r.nextPageToken || '';
  } while (pageToken);

  const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = { created: 0, updated: 0, removed: 0, total: desired.length };
  for (const ev of desired) {
    const known = existing.has(ev.id);
    const sig = existing.get(ev.id);
    existing.delete(ev.id);
    if (known && sig === ev.extendedProperties.private.sig) continue;
    if (known) {
      await gfetch(`${base}/${ev.id}`, { method: 'PUT', ...json(ev) });
      out.updated++;
      continue;
    }
    try {
      await gfetch(base, { method: 'POST', ...json(ev) });
    } catch (e) {
      // id já usado por um evento apagado antes: atualizar o restaura
      if (e.status !== 409) throw e;
      await gfetch(`${base}/${ev.id}`, { method: 'PUT', ...json({ ...ev, status: 'confirmed' }) });
    }
    out.created++;
  }
  for (const id of existing.keys()) { // pago, excluído ou fora do período
    try { await gfetch(`${base}/${id}`, { method: 'DELETE' }); out.removed++; }
    catch (e) { if (e.status !== 410) throw e; } // já apagado
  }
  return out;
}
