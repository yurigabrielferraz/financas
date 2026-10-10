// Lembretes no Google Agenda: cada saída/conta e cada vencimento de fatura não pagos viram um evento
// numa agenda própria ("Minhas Finanças"). Pago/excluído -> evento removido; valor/data mudou -> atualizado.
// Escopo calendar.app.created: o app só enxerga as agendas que ele mesmo criou.
import { fmtMoney, fmtDateFull } from './utils.js';

export const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TZ = 'America/Sao_Paulo';
const pad = n => String(n).padStart(2, '0');

/** ID fixo por lançamento/fatura (a API aceita a-v e 0-9): sincronizar de novo não duplica. */
export const eventId = key => 'fin' + [...new TextEncoder().encode(key)].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Eventos desejados a partir de /upcoming. Evento curto às `hour`h do vencimento, com lembrete
 * N dias antes (antecedência da conta) e outro na hora.
 */
export function buildEvents(items, hour, siteUrl) {
  return items.map(it => {
    const invoice = it.type === 'invoice';
    const key = invoice ? `inv:${it.card_id}:${it.month}` : `tx:${it.id}`;
    const summary = `${invoice ? '💳' : '💸'} ${it.description} — ${fmtMoney(it.amount)}`;
    const minutes = Math.min(40320, Math.max(0, it.remind_days) * 1440); // máximo da API: 4 semanas
    const overrides = [{ method: 'popup', minutes: 0 }];
    if (minutes > 0) overrides.unshift({ method: 'popup', minutes });
    const at = m => ({ dateTime: `${it.due_date}T${pad(hour)}:${pad(m)}:00`, timeZone: TZ });
    return {
      id: eventId(key),
      summary,
      description: `${invoice ? 'Fatura do cartão' : 'Conta a pagar'}: ${fmtMoney(it.amount)}\nVencimento: ${fmtDateFull(it.due_date)}\n\n${siteUrl}`,
      start: at(0),
      end: at(15),
      transparency: 'transparent',
      colorId: invoice ? '9' : '11',
      reminders: { useDefault: false, overrides },
      extendedProperties: { private: { app: 'financas', sig: [summary, it.due_date, hour, minutes].join('|') } },
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
