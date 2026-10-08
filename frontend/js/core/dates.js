// Datas como strings ISO (AAAA-MM-DD) e meses como AAAA-MM. Aritmética em UTC (sem fuso).
// Regras de dias úteis, faturas e recorrências.

const pad = n => String(n).padStart(2, '0');
const toDate = iso => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
const fromDate = d => d.toISOString().slice(0, 10);

export const ym = iso => iso.slice(0, 7);
export const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const addDays = (iso, n) => fromDate(new Date(toDate(iso).getTime() + n * 86400000));
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
/** 0 = segunda ... 6 = domingo (como date.weekday() do Python). */
export const weekday = iso => (toDate(iso).getUTCDay() + 6) % 7;

export function parseYm(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m || +m[2] < 1 || +m[2] > 12) throw new RangeError(`Mês inválido: ${month} (use AAAA-MM)`);
  return [+m[1], +m[2]];
}

export function shiftYm(month, n) {
  const [y, m] = parseYm(month);
  const idx = y * 12 + (m - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${pad((idx % 12 + 12) % 12 + 1)}`;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Dia `day` do mês; se o mês for mais curto, usa o último dia (31 -> 28/fev). */
export const clampDate = (y, m, day) => isoOf(y, m, Math.min(day, daysInMonth(y, m)));

export function addMonths(iso, n) {
  const [y, m] = parseYm(shiftYm(ym(iso), n));
  return clampDate(y, m, +iso.slice(8, 10));
}

export function monthBounds(month) {
  const [y, m] = parseYm(month);
  return [isoOf(y, m, 1), clampDate(y, m, 31)];
}

// ------------------------------------------------------------------ dias úteis

const FIXED_HOLIDAYS = [[1, 1], [4, 21], [5, 1], [9, 7], [10, 12], [11, 2], [11, 15], [11, 20], [12, 25]];
const holidayCache = new Map();

/** Domingo de Páscoa (Meeus/Jones/Butcher). */
export function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return isoOf(year, month, day);
}

/** Feriados nacionais + dias sem expediente bancário (Carnaval, Sexta-feira Santa, Corpus Christi). */
export function holidays(year) {
  if (!holidayCache.has(year)) {
    const e = easter(year);
    holidayCache.set(year, new Set([
      ...FIXED_HOLIDAYS.map(([m, d]) => isoOf(year, m, d)),
      addDays(e, -48), addDays(e, -47), addDays(e, -2), addDays(e, 60),
    ]));
  }
  return holidayCache.get(year);
}

export const isBusinessDay = iso => weekday(iso) < 5 && !holidays(+iso.slice(0, 4)).has(iso);

export function nextBusinessDay(iso) {
  while (!isBusinessDay(iso)) iso = addDays(iso, 1);
  return iso;
}

// ------------------------------------------------------------------ cartões

/** Mês em que vence a fatura de uma compra. Compras no dia do fechamento ou depois vão para a seguinte. */
export function invoiceMonthFor(purchase, closingDay, dueDay) {
  const [y, m] = parseYm(ym(purchase));
  const closing = clampDate(y, m, closingDay);
  const closingMonth = purchase < closing ? ym(purchase) : shiftYm(ym(purchase), 1);
  return dueDay > closingDay ? closingMonth : shiftYm(closingMonth, 1);
}

export function invoiceClosingDate(month, closingDay, dueDay) {
  const [y, m] = parseYm(dueDay > closingDay ? month : shiftYm(month, -1));
  return clampDate(y, m, closingDay);
}

export function invoiceDueDate(month, dueDay) {
  const [y, m] = parseYm(month);
  return nextBusinessDay(clampDate(y, m, dueDay));
}

export function invoiceStatus(today, closing, due, paid) {
  if (paid) return 'paga';
  if (today > due) return 'vencida';
  if (today >= closing) return 'fechada';
  return 'aberta';
}

// ------------------------------------------------------------------ recorrências

export function occurrences(frequency, day, start, end, month) {
  const [y, m] = parseYm(month);
  const [first, last] = monthBounds(month);
  const target = day || +start.slice(8, 10);
  let dates;
  if (frequency === 'monthly') dates = [clampDate(y, m, target)];
  else if (frequency === 'yearly') dates = m === +start.slice(5, 7) ? [clampDate(y, m, target)] : [];
  else { // weekly: mesmo dia da semana da data de início
    const offset = ((daysBetween(start, first) % 7) + 7) % 7;
    dates = [];
    for (let d = addDays(first, (7 - offset) % 7); d <= last; d = addDays(d, 7)) dates.push(d);
  }
  return dates.filter(d => d >= start && (!end || d <= end));
}
