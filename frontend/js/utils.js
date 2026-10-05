const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho',
  'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pad = n => String(n).padStart(2, '0');

export const fmtMoney = cents => BRL.format((cents || 0) / 100);

/** "1.234,56", "1234.56", "R$ 12" -> centavos */
export function parseMoney(str) {
  let s = String(str ?? '').replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export const centsToInput = c => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const currentMonth = () => todayISO().slice(0, 7);

export function shiftMonth(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const idx = y * 12 + mo - 1 + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

export function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
}
export const monthShort = m => `${MONTHS[+m.slice(5, 7) - 1].slice(0, 3)}/${m.slice(2, 4)}`;

export const fmtDate = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
export const fmtDateFull = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

export function fmtDayHeader(iso) {
  const d = new Date(iso + 'T12:00:00');
  const t = todayISO();
  if (iso === t) return 'Hoje';
  return `${WEEKDAYS[d.getDay()]}, ${fmtDateFull(iso)}`;
}

export function daysUntil(iso) {
  const a = new Date(todayISO() + 'T12:00:00');
  const b = new Date(iso + 'T12:00:00');
  return Math.round((b - a) / 86400000);
}

export function dueLabel(days) {
  if (days < 0) return `venceu há ${-days} dia${days < -1 ? 's' : ''}`;
  if (days === 0) return 'vence hoje';
  if (days === 1) return 'vence amanhã';
  return `vence em ${days} dias`;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

export function storage(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem storage */ }
}
