// "Servidor" que roda no navegador: mesmas rotas e regras da antiga API Python, sobre um banco
// SQLite em memória (sql.js). Valores em centavos; datas AAAA-MM-DD; meses AAAA-MM.
import * as D from './dates.js';

export const SCHEMA_VERSION = 4;
export const DATA_TABLES = ['transactions', 'recurrence_skips', 'recurrences', 'invoice_payments', 'cards', 'categories', 'accounts'];
const DEFAULT_SETTINGS = { reminder_days_default: 3, notify_hour: 8 };
const BOOL_FIELDS = ['paid', 'archived', 'active'];

export class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

// ------------------------------------------------------------------ acesso ao banco

/** Envolve um sql.js Database com consultas que devolvem objetos. */
export function wrap(sdb) {
  const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const all = (sql, params = []) => {
    const st = sdb.prepare(sql);
    try {
      st.bind(params.map(norm));
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally { st.free(); }
  };
  return {
    raw: sdb,
    all,
    get: (sql, params) => all(sql, params)[0] ?? null,
    scalar: (sql, params) => { const r = all(sql, params)[0]; return r ? Object.values(r)[0] ?? 0 : 0; },
    run: (sql, params = []) => sdb.run(sql, params.map(norm)),
    exec: sql => sdb.exec(sql),
    insert(table, data) {
      const cols = Object.keys(data);
      sdb.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(data).map(norm));
      return all('SELECT last_insert_rowid() AS id')[0].id;
    },
    update(table, id, data) {
      const cols = Object.keys(data);
      sdb.run(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...Object.values(data).map(norm), id]);
    },
    tx(fn) {
      sdb.exec('SAVEPOINT tx');
      try { const r = fn(); sdb.exec('RELEASE tx'); return r; }
      catch (e) { sdb.exec('ROLLBACK TO tx; RELEASE tx'); throw e; }
    },
  };
}

/** Cria/atualiza o schema (mesmas migrações do backend Python). */
export function upgrade(db, schemaSql, seedSql, today) {
  const version = db.scalar('PRAGMA user_version');
  if (version > SCHEMA_VERSION) throw new HttpError(400, `Arquivo de uma versão mais nova do app (v${version}).`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql);
  if (version === 0) db.exec(seedSql);
  const addColumn = (t, col) => {
    if (!db.all(`PRAGMA table_info(${t})`).some(c => c.name === col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} TEXT`);
  };
  addColumn('transactions', 'nature'); // v2
  addColumn('recurrences', 'nature'); // v2
  addColumn('recurrences', 'due_shift'); // v4
  if (version > 0 && version < 3) {
    db.run(`DELETE FROM transactions WHERE recurrence_id IS NOT NULL AND paid = 0
            AND card_id IS NULL AND recurrence_date >= ?`, [today]);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Confere se um arquivo é um banco deste app (antes de importar). */
export function checkBackup(db) {
  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name));
  const missing = DATA_TABLES.filter(t => !tables.has(t));
  if (missing.length) throw new HttpError(400, `O arquivo não parece ser um backup deste app (faltam tabelas: ${missing.join(', ')})`);
}

const toDict = row => {
  if (!row) return row;
  const d = { ...row };
  for (const k of BOOL_FIELDS) if (k in d) d[k] = !!d[k];
  return d;
};
const normNature = (kind, nature) => (kind === 'expense' || nature === 'saving' ? nature ?? null : null);

// ------------------------------------------------------------------ servidor

export function createServer(db, schemaSql, seedSql, todayFn = defaultToday) {
  const today = () => todayFn();

  const fetchRow = (table, id) => {
    const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!row) throw new HttpError(404, `${table}: id ${id} não encontrado`);
    return row;
  };
  const checkRefs = refs => {
    const tables = { category_id: 'categories', account_id: 'accounts', card_id: 'cards' };
    for (const [f, v] of Object.entries(refs)) if (v != null) fetchRow(tables[f], v);
  };
  const validMonth = month => {
    if (!month) return D.ym(today());
    try { D.parseYm(month); } catch (e) { throw new HttpError(422, e.message); }
    return month;
  };
  const require = (cond, msg) => { if (!cond) throw new HttpError(422, msg); };

  // ---------------------------------------------------------------- regras (logic.py)

  const getSettings = () => {
    const s = { ...DEFAULT_SETTINGS };
    for (const r of db.all('SELECT key, value FROM settings')) {
      try { s[r.key] = JSON.parse(r.value); } catch { /* valor inválido */ }
    }
    return s;
  };

  const invoiceTotals = month => Object.fromEntries(db.all(
    `SELECT card_id, SUM(CASE WHEN kind = 'expense' THEN amount ELSE -amount END) AS total
     FROM transactions WHERE card_id IS NOT NULL AND invoice_month = ? GROUP BY card_id`, [month],
  ).map(r => [r.card_id, r.total]));

  function invoiceSummary(card, month, t) {
    const total = invoiceTotals(month)[card.id] ?? 0;
    const payment = db.get('SELECT * FROM invoice_payments WHERE card_id = ? AND month = ?', [card.id, month]);
    const closing = D.invoiceClosingDate(month, card.closing_day, card.due_day);
    const due = D.invoiceDueDate(month, card.due_day);
    return {
      card_id: card.id, card_name: card.name, color: card.color, month, total,
      closing_date: closing, due_date: due, paid: !!payment,
      paid_amount: payment ? payment.amount : null, paid_date: payment ? payment.paid_date : null,
      status: D.invoiceStatus(t, closing, due, !!payment),
    };
  }

  const usedLimit = cardId => db.scalar(
    `SELECT COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount ELSE -t.amount END), 0)
     FROM transactions t WHERE t.card_id = ? AND NOT EXISTS (
       SELECT 1 FROM invoice_payments ip WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)`, [cardId]);

  /** Cria (se ainda não existirem) os lançamentos das recorrências ativas no mês. */
  function ensureMonth(month) {
    const cards = Object.fromEntries(db.all('SELECT * FROM cards').map(c => [c.id, c]));
    const skips = new Set(db.all('SELECT recurrence_id, date FROM recurrence_skips').map(r => `${r.recurrence_id}|${r.date}`));
    for (const rec of db.all('SELECT * FROM recurrences WHERE active = 1')) {
      for (const d of D.occurrences(rec.frequency, rec.day, rec.start_date, rec.end_date, month)) {
        if (skips.has(`${rec.id}|${d}`)) continue;
        const card = cards[rec.card_id];
        const due = shiftedDate(rec, d, card);
        const accountId = card ? null : rec.account_id;
        const cardId = card ? card.id : null;
        const invoiceMonth = card ? D.invoiceMonthFor(d, card.closing_day, card.due_day) : null;
        db.run(
          `INSERT OR IGNORE INTO transactions
           (kind, description, amount, date, category_id, account_id, card_id, invoice_month,
            recurrence_id, recurrence_date, nature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [rec.kind, rec.description, rec.amount, due, rec.category_id, accountId, cardId, invoiceMonth, rec.id, d, rec.nature],
        );
        // ocorrência já existente e não paga, gerada antes de trocar conta <-> cartão: acompanha a recorrência
        db.run(
          `UPDATE transactions SET card_id = ?, account_id = ?, invoice_month = ?, date = ?
           WHERE recurrence_id = ? AND recurrence_date = ? AND paid = 0 AND card_id IS NOT ?
             AND (card_id IS NULL OR NOT EXISTS (SELECT 1 FROM invoice_payments ip
                  WHERE ip.card_id = transactions.card_id AND ip.month = transactions.invoice_month))`,
          [cardId, accountId, invoiceMonth, due, rec.id, d, cardId],
        );
      }
    }
  }

  /** Data efetiva de uma ocorrência: ajusta fim de semana/feriado conforme `due_shift` da recorrência. */
  function shiftedDate(rec, d, card) {
    const shift = rec.due_shift || (rec.kind === 'expense' && !card ? 'next' : 'none');
    return shift === 'next' ? D.nextBusinessDay(d) : shift === 'previous' ? D.previousBusinessDay(d) : d;
  }

  const clearFutureOccurrences = id => db.run(
    `DELETE FROM transactions WHERE recurrence_id = ? AND recurrence_date >= ? AND paid = 0
       AND (card_id IS NULL OR NOT EXISTS (SELECT 1 FROM invoice_payments ip
            WHERE ip.card_id = transactions.card_id AND ip.month = transactions.invoice_month))`, [id, today()]);

  const accountBalances = () => db.all(
    `SELECT a.*, a.initial_balance
       + COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END)
                   FROM transactions t WHERE t.account_id = a.id AND t.card_id IS NULL AND t.paid = 1), 0)
       - COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.account_id = a.id), 0) AS balance
     FROM accounts a ORDER BY a.archived, a.name`);

  const TX_SELECT = `
    SELECT t.id, t.kind, t.description, t.amount, t.date, t.category_id, t.account_id, t.card_id,
           t.invoice_month, t.paid_date, t.recurrence_id, t.recurrence_date, t.installment_group,
           t.installment_no, t.installment_total, t.reminder_days, t.notes, t.nature, t.created_at, t.updated_at,
           CASE WHEN t.card_id IS NOT NULL THEN EXISTS (
             SELECT 1 FROM invoice_payments ip WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)
           ELSE t.paid END AS paid,
           c.name AS category_name, c.color AS category_color,
           a.name AS account_name, k.name AS card_name, k.color AS card_color, r.bill_type
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN cards k ON k.id = t.card_id
    LEFT JOIN recurrences r ON r.id = t.recurrence_id`;

  const txOut = id => {
    const row = db.get(`${TX_SELECT} WHERE t.id = ?`, [id]);
    if (!row) throw new HttpError(404, `transactions: id ${id} não encontrado`);
    return toDict(row);
  };

  function summary(month, t) {
    ensureMonth(D.shiftYm(month, -1));
    ensureMonth(month);
    const rng = D.monthBounds(month);
    const totals = { 'income:0': 0, 'income:1': 0, 'expense:0': 0, 'expense:1': 0 };
    for (const r of db.all(`SELECT kind, paid, SUM(amount) AS total FROM transactions
                            WHERE card_id IS NULL AND date BETWEEN ? AND ? GROUP BY kind, paid`, rng)) {
      totals[`${r.kind}:${r.paid}`] = r.total;
    }
    const invoices = db.all('SELECT * FROM cards ORDER BY name').map(c => invoiceSummary(c, month, t))
      .filter(i => i.total || i.paid);
    const invTotal = invoices.reduce((a, i) => a + i.total, 0);
    const invPaid = invoices.filter(i => i.paid).reduce((a, i) => a + i.paid_amount, 0);
    const incomeTotal = totals['income:0'] + totals['income:1'];
    const expenseTotal = totals['expense:0'] + totals['expense:1'] + invTotal;
    const expensePaid = totals['expense:1'] + invPaid;
    return {
      month,
      income: { total: incomeTotal, received: totals['income:1'] },
      expense: { total: expenseTotal, paid: expensePaid },
      balance_forecast: incomeTotal - expenseTotal,
      balance_realized: totals['income:1'] - expensePaid,
      accounts_balance: accountBalances().filter(a => !a.archived).reduce((s, a) => s + a.balance, 0),
      by_category: db.all(
        `SELECT c.id, COALESCE(c.name, 'Sem categoria') AS name, COALESCE(c.color, '#94a3b8') AS color,
                SUM(t.amount) AS total
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.kind = 'expense' AND t.date BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC`, rng),
      invoices,
      pending: db.all(`${TX_SELECT} WHERE t.card_id IS NULL AND t.paid = 0 AND t.date BETWEEN ? AND ?
                       ORDER BY t.date, t.description`, rng).map(toDict),
    };
  }

  /** Sem horizonDays: só contas na janela de lembrete. Com horizonDays: todas que vencem até lá. */
  function reminders(t, horizonDays = null) {
    const defaultDays = +getSettings().reminder_days_default;
    const cur = D.ym(t);
    const lastMonth = D.ym(D.addDays(t, Math.max(horizonDays || 0, 31)));
    const months = [D.shiftYm(cur, -2), D.shiftYm(cur, -1)];
    while (months[months.length - 1] < lastMonth) months.push(D.shiftYm(months[months.length - 1], 1));
    months.slice(1).forEach(ensureMonth);
    const include = (days, window) => days <= (horizonDays ?? window);
    const status = days => (days < 0 ? 'overdue' : days === 0 ? 'today' : 'upcoming');
    const items = [];
    for (const r of db.all(
      `SELECT t.id, t.description, t.amount, t.date, t.reminder_days, r.reminder_days AS rec_days,
              r.bill_type, c.name AS category_name
       FROM transactions t LEFT JOIN recurrences r ON r.id = t.recurrence_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.card_id IS NULL AND t.kind = 'expense' AND t.paid = 0 AND t.date <= ?`,
      [D.addDays(t, Math.max(horizonDays || 0, 62))])) {
      const days = D.daysBetween(t, r.date);
      const window = r.reminder_days ?? r.rec_days ?? defaultDays;
      if (include(days, window)) {
        items.push({
          type: 'transaction', id: r.id, description: r.description, amount: r.amount, due_date: r.date,
          days_until: days, status: status(days), bill_type: r.bill_type, category_name: r.category_name,
          remind_days: window, remind_on: D.addDays(r.date, -window),
        });
      }
    }
    for (const card of db.all('SELECT * FROM cards WHERE archived = 0')) {
      const window = card.reminder_days ?? defaultDays;
      for (const m of months) {
        const inv = invoiceSummary(card, m, t);
        if (inv.paid || inv.total <= 0) continue;
        const days = D.daysBetween(t, inv.due_date);
        if (include(days, window)) {
          items.push({
            type: 'invoice', id: `${card.id}:${m}`, card_id: card.id, month: m, description: `Fatura ${card.name}`,
            amount: inv.total, due_date: inv.due_date, days_until: days, status: status(days),
            remind_days: window, remind_on: D.addDays(inv.due_date, -window),
          });
        }
      }
    }
    return items.sort((a, b) => (a.due_date + a.description).localeCompare(b.due_date + b.description));
  }

  /** Saldo projetado dia a dia: tudo que está lançado na data (pago ou não) e cada fatura no vencimento. */
  function dailyGrid(start, months) {
    const COLS = ['income', 'bills', 'daily', 'savings', 'card'];
    const monthList = Array.from({ length: months }, (_, i) => D.shiftYm(start, i));
    [D.shiftYm(start, -1), ...monthList].forEach(ensureMonth);
    const first = D.monthBounds(monthList[0])[0];
    const last = D.monthBounds(monthList[monthList.length - 1])[1];
    let opening = db.scalar('SELECT COALESCE(SUM(initial_balance), 0) FROM accounts')
      + db.scalar(`SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE -amount END), 0)
                   FROM transactions WHERE card_id IS NULL AND date < ?`, [first]);
    const buckets = new Map();
    const bucket = d => {
      if (!buckets.has(d)) buckets.set(d, Object.fromEntries(COLS.map(c => [c, 0])));
      return buckets.get(d);
    };
    const dueDays = Object.fromEntries(db.all('SELECT id, due_day FROM cards').map(c => [c.id, c.due_day]));
    const payments = Object.fromEntries(db.all('SELECT card_id, month, amount FROM invoice_payments')
      .map(p => [`${p.card_id}|${p.month}`, p.amount]));
    for (const r of db.all(`SELECT card_id, invoice_month, SUM(CASE WHEN kind = 'expense' THEN amount ELSE -amount END) AS total
                            FROM transactions WHERE card_id IS NOT NULL GROUP BY card_id, invoice_month`)) {
      if (dueDays[r.card_id] == null) continue;
      const due = D.invoiceDueDate(r.invoice_month, dueDays[r.card_id]);
      const amount = payments[`${r.card_id}|${r.invoice_month}`] ?? r.total;
      if (due < first) opening -= amount;
      else if (due <= last) bucket(due).card += amount;
    }
    for (const r of db.all(`SELECT kind, nature, amount, date FROM transactions
                            WHERE card_id IS NULL AND date BETWEEN ? AND ?`, [first, last])) {
      let col = 'bills', sign = 1;
      if (r.kind === 'income') [col, sign] = r.nature === 'saving' ? ['savings', -1] : ['income', 1];
      else if (r.nature === 'daily') col = 'daily';
      else if (r.nature === 'saving') col = 'savings';
      bucket(r.date)[col] += sign * r.amount;
    }
    let balance = opening;
    const result = monthList.map(m => {
      const [d0, end] = D.monthBounds(m);
      const days = [];
      const totals = Object.fromEntries(COLS.map(c => [c, 0]));
      for (let d = d0; d <= end; d = D.addDays(d, 1)) {
        const b = buckets.get(d) || Object.fromEntries(COLS.map(c => [c, 0]));
        balance += b.income - b.bills - b.daily - b.savings - b.card;
        for (const c of COLS) totals[c] += b[c];
        days.push({ date: d, ...b, balance });
      }
      return { month: m, days, totals, end_balance: balance };
    });
    return { start, opening_balance: opening, months: result };
  }

  // ---------------------------------------------------------------- importação de fatura

  /** Categoria do Itaú (linha abaixo do lançamento) -> nome da categoria padrão do app. */
  const ITAU_CATEGORY = {
    transporte: 'Transporte', restaurante: 'Alimentação', supermercado: 'Mercado', educacao: 'Educação',
    'educação': 'Educação', eletronicos: 'Compras', 'eletrônicos': 'Compras', vestuario: 'Compras',
    'vestuário': 'Compras', retail: 'Compras', saude: 'Saúde', 'saúde': 'Saúde', servicos: 'Assinaturas',
    'serviços': 'Assinaturas', hospedagem: 'Lazer', turismo: 'Lazer', entretenimento: 'Lazer',
  };
  const normDesc = d => String(d).toUpperCase().replace(/\s+/g, ' ').trim();

  /**
   * Lançamento do app que corresponde a um item da fatura (para não duplicar). Parcela k/n: mesma fatura,
   * mesmo k/n e data da compra (gravada como compra + k-1 meses). `used`: ids já casados nesta leitura,
   * para que duas compras iguais no mesmo dia não virem uma só.
   */
  function findExisting(cardId, month, it, used) {
    const notUsed = used.size ? ` AND id NOT IN (${[...used].join(',')})` : '';
    const row = it.installmentNo
      ? db.get(`SELECT id, amount FROM transactions WHERE card_id = ? AND invoice_month = ? AND installment_no = ?
                AND installment_total = ? AND date = ?${notUsed} LIMIT 1`,
      [cardId, month, it.installmentNo, it.installmentTotal, D.addMonths(it.date, it.installmentNo - 1)])
      : db.get(`SELECT id, amount FROM transactions WHERE card_id = ? AND invoice_month = ? AND date = ?
                AND amount = ? AND installment_no IS NULL${notUsed} LIMIT 1`, [cardId, month, it.date, Math.abs(it.amount)]);
    if (row) used.add(row.id);
    return row;
  }

  function suggestCategory(it) {
    const learned = db.get(`SELECT category_id FROM transactions WHERE UPPER(description) = ? AND category_id IS NOT NULL
                            ORDER BY updated_at DESC, id DESC LIMIT 1`, [normDesc(it.description)]);
    if (learned) return learned.category_id;
    const name = ITAU_CATEGORY[it.itauCategory];
    return name ? db.get("SELECT id FROM categories WHERE name = ? AND kind = 'expense'", [name])?.id ?? null : null;
  }

  /** Nome escolhido pelo usuário em importações anteriores, por descrição da fatura. */
  const getAliases = () => getSettings().import_aliases || {};

  /** Compara a fatura lida com o que já está no app: cada item vira new | exists | update. */
  function importPreview(cardId, statement) {
    fetchRow('cards', cardId);
    const month = D.ym(statement.dueDate);
    const used = new Set();
    const aliases = getAliases();
    return {
      month,
      items: statement.items.map(it => {
        const ex = findExisting(cardId, month, it, used);
        const name = aliases[normDesc(it.description)] || it.description;
        // categoria aprendida dos lançamentos já gravados com esse nome (inclui correções feitas depois)
        const category = suggestCategory({ ...it, description: name }) ?? suggestCategory(it);
        return { ...it, name, existing_id: ex?.id ?? null, category_id: category,
          status: !ex ? 'new' : ex.amount === Math.abs(it.amount) ? 'exists' : 'update' };
      }),
    };
  }

  /**
   * Grava os itens marcados. Parcela k/n cria k..n (uma por fatura); valor negativo = estorno/crédito.
   * `name` (opcional) é o nome escolhido pelo usuário; fica lembrado para as próximas importações.
   */
  function importItems(cardId, month, items) {
    fetchRow('cards', cardId);
    const out = { created: 0, updated: 0, skipped: 0 };
    const used = new Set();
    const aliases = getAliases();
    for (const it of items) {
      const name = String(it.name || '').trim() || it.description;
      if (name !== it.description) aliases[normDesc(it.description)] = name;
      const ex = findExisting(cardId, month, it, used);
      if (ex) {
        if (ex.amount !== Math.abs(it.amount)) { db.update('transactions', ex.id, { amount: Math.abs(it.amount) }); out.updated++; }
        else out.skipped++;
        continue;
      }
      const base = { kind: it.amount < 0 ? 'income' : 'expense', description: name, amount: Math.abs(it.amount),
        category_id: it.category_id ?? null, card_id: cardId, paid: false };
      if (!it.installmentNo) {
        used.add(db.insert('transactions', { ...base, date: it.date, invoice_month: month }));
        out.created++;
        continue;
      }
      const group = crypto.randomUUID().replaceAll('-', '');
      for (let k = it.installmentNo; k <= it.installmentTotal; k++) {
        const m = D.shiftYm(month, k - it.installmentNo);
        if (k > it.installmentNo && findExisting(cardId, m, { ...it, installmentNo: k }, used)) continue;
        used.add(db.insert('transactions', { ...base, date: D.addMonths(it.date, k - 1), invoice_month: m,
          installment_group: group, installment_no: k, installment_total: it.installmentTotal }));
      }
      out.created++;
    }
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['import_aliases', JSON.stringify(aliases)]);
    return out;
  }

  // ---------------------------------------------------------------- rotas (main.py)

  const accountData = b => {
    require(b.name?.trim(), 'Informe o nome');
    return { name: b.name, type: b.type ?? 'checking', initial_balance: b.initial_balance ?? 0,
      color: b.color ?? '#4f46e5', archived: !!b.archived };
  };
  const categoryData = b => {
    require(b.name?.trim() && ['expense', 'income'].includes(b.kind), 'Informe nome e tipo');
    return { name: b.name, kind: b.kind, color: b.color ?? '#64748b', icon: b.icon ?? '', archived: !!b.archived };
  };
  const cardData = b => {
    require(b.name?.trim(), 'Informe o nome');
    require(b.closing_day >= 1 && b.closing_day <= 31 && b.due_day >= 1 && b.due_day <= 31, 'Dias de fechamento/vencimento entre 1 e 31');
    checkRefs({ account_id: b.account_id });
    return { name: b.name, credit_limit: b.credit_limit ?? 0, closing_day: b.closing_day, due_day: b.due_day,
      color: b.color ?? '#0ea5e9', account_id: b.account_id ?? null, reminder_days: b.reminder_days ?? null,
      archived: !!b.archived };
  };
  const recurrenceData = b => {
    require(b.description?.trim() && b.amount >= 0 && b.start_date, 'Informe descrição, valor e início');
    checkRefs({ category_id: b.category_id, account_id: b.account_id, card_id: b.card_id });
    const kind = b.kind ?? 'expense';
    return { description: b.description, kind, bill_type: b.bill_type ?? 'fixa', amount: b.amount,
      category_id: b.category_id ?? null, account_id: b.account_id ?? null, card_id: b.card_id ?? null,
      frequency: b.frequency ?? 'monthly', day: b.day ?? null, start_date: b.start_date, end_date: b.end_date ?? null,
      reminder_days: b.reminder_days ?? null, active: b.active ?? true, notes: b.notes ?? null,
      nature: normNature(kind, b.nature),
      due_shift: ['next', 'previous', 'none'].includes(b.due_shift) ? b.due_shift : null };
  };
  /** Normaliza campos do lançamento: cartão define a fatura e ignora conta/pago. */
  const txFields = b => {
    require(['expense', 'income'].includes(b.kind) && b.description?.trim() && b.amount >= 0 && b.date, 'Dados do lançamento inválidos');
    checkRefs({ category_id: b.category_id, account_id: b.account_id, card_id: b.card_id });
    const data = { kind: b.kind, description: b.description, amount: b.amount, date: b.date,
      category_id: b.category_id ?? null, account_id: b.account_id ?? null, card_id: b.card_id ?? null,
      paid: !!b.paid, paid_date: b.paid_date ?? null, reminder_days: b.reminder_days ?? null,
      notes: b.notes ?? null, nature: normNature(b.kind, b.nature), invoice_month: null };
    if (b.card_id != null) {
      const card = fetchRow('cards', b.card_id);
      Object.assign(data, { account_id: null, paid: false, paid_date: null,
        invoice_month: D.invoiceMonthFor(b.date, card.closing_day, card.due_day) });
    } else if (data.paid) {
      data.paid_date ??= b.date < today() ? b.date : today();
    } else {
      data.paid_date = null;
    }
    return data;
  };

  const cardOut = (card, month, t) => {
    const used = usedLimit(card.id);
    return { ...toDict(card), used_limit: used, available_limit: card.credit_limit - used,
      current_invoice: invoiceSummary(card, month || D.invoiceMonthFor(t, card.closing_day, card.due_day), t) };
  };

  const recurrenceOut = (r, t) => {
    const cur = D.ym(t);
    const occ = db.get(`SELECT id, date, amount, paid, card_id FROM transactions
                        WHERE recurrence_id = ? AND substr(recurrence_date, 1, 7) = ? ORDER BY date LIMIT 1`, [r.id, cur]);
    let next = null;
    if (r.active) {
      for (let i = 0; i < 13 && !next; i++) {
        next = D.occurrences(r.frequency, r.day, r.start_date, r.end_date, D.shiftYm(cur, i))
          .map(x => shiftedDate(r, x, r.card_id)).find(x => x >= t) ?? null;
      }
    }
    return { ...toDict(r), current: toDict(occ), next_date: next };
  };

  const routes = [
    // contas
    ['GET', '/accounts', () => accountBalances().map(toDict)],
    ['POST', '/accounts', ({ body }) => toDict(fetchRow('accounts', db.insert('accounts', accountData(body))))],
    ['PUT', '/accounts/:id', ({ id, body }) => { fetchRow('accounts', id); db.update('accounts', id, accountData(body)); return toDict(fetchRow('accounts', id)); }],
    ['DELETE', '/accounts/:id', ({ id }) => {
      fetchRow('accounts', id);
      const used = !!db.get('SELECT 1 FROM transactions WHERE account_id = ? UNION SELECT 1 FROM invoice_payments WHERE account_id = ?', [id, id]);
      db.run(used ? 'UPDATE accounts SET archived = 1 WHERE id = ?' : 'DELETE FROM accounts WHERE id = ?', [id]);
      return { archived: used, deleted: !used };
    }],
    // categorias
    ['GET', '/categories', ({ q }) => (q.kind
      ? db.all('SELECT * FROM categories WHERE kind = ? ORDER BY kind, name', [q.kind])
      : db.all('SELECT * FROM categories ORDER BY kind, name')).map(toDict)],
    ['POST', '/categories', ({ body }) => toDict(fetchRow('categories', db.insert('categories', categoryData(body))))],
    ['PUT', '/categories/:id', ({ id, body }) => { fetchRow('categories', id); db.update('categories', id, categoryData(body)); return toDict(fetchRow('categories', id)); }],
    ['DELETE', '/categories/:id', ({ id }) => { fetchRow('categories', id); db.run('DELETE FROM categories WHERE id = ?', [id]); return null; }],
    // cartões
    ['GET', '/cards', ({ q }) => {
      const month = q.month ? validMonth(q.month) : null;
      const t = today();
      ensureMonth(D.ym(t));
      ensureMonth(D.shiftYm(D.ym(t), 1));
      return db.all('SELECT * FROM cards ORDER BY archived, name').map(c => cardOut(c, month, t));
    }],
    ['POST', '/cards', ({ body }) => cardOut(fetchRow('cards', db.insert('cards', cardData(body))), null, today())],
    ['PUT', '/cards/:id', ({ id, body }) => {
      const old = fetchRow('cards', id);
      const data = cardData(body);
      db.update('cards', id, data);
      if (old.closing_day !== data.closing_day || old.due_day !== data.due_day) {
        // recalcula a fatura dos lançamentos em faturas ainda não pagas
        for (const r of db.all(`SELECT id, date FROM transactions t WHERE card_id = ? AND NOT EXISTS (
            SELECT 1 FROM invoice_payments ip WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)`, [id])) {
          db.run('UPDATE transactions SET invoice_month = ? WHERE id = ?', [D.invoiceMonthFor(r.date, data.closing_day, data.due_day), r.id]);
        }
      }
      return cardOut(fetchRow('cards', id), null, today());
    }],
    ['DELETE', '/cards/:id', ({ id }) => {
      fetchRow('cards', id);
      const used = !!db.get('SELECT 1 FROM transactions WHERE card_id = ? LIMIT 1', [id]);
      db.run(used ? 'UPDATE cards SET archived = 1 WHERE id = ?' : 'DELETE FROM cards WHERE id = ?', [id]);
      return { archived: used, deleted: !used };
    }],
    ['GET', '/cards/:id/invoice', ({ id, q }) => {
      const card = fetchRow('cards', id);
      const t = today();
      const month = q.month ? validMonth(q.month) : D.invoiceMonthFor(t, card.closing_day, card.due_day);
      [-2, -1, 0].forEach(k => ensureMonth(D.shiftYm(month, k)));
      return { ...invoiceSummary(card, month, t),
        items: db.all(`${TX_SELECT} WHERE t.card_id = ? AND t.invoice_month = ? ORDER BY t.date, t.id`, [id, month]).map(toDict) };
    }],
    ['POST', '/cards/:id/invoice/:month/pay', ({ id, month, body }) => {
      const card = fetchRow('cards', id);
      month = validMonth(month);
      const accountId = body.account_id ?? card.account_id;
      checkRefs({ account_id: accountId });
      const amount = body.amount ?? invoiceTotals(month)[id] ?? 0;
      db.run(`INSERT INTO invoice_payments (card_id, month, amount, paid_date, account_id) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(card_id, month) DO UPDATE SET
                amount = excluded.amount, paid_date = excluded.paid_date, account_id = excluded.account_id`,
      [id, month, amount, body.paid_date || today(), accountId]);
      return invoiceSummary(card, month, today());
    }],
    ['DELETE', '/cards/:id/invoice/:month/pay', ({ id, month }) => {
      const card = fetchRow('cards', id);
      db.run('DELETE FROM invoice_payments WHERE card_id = ? AND month = ?', [id, validMonth(month)]);
      return invoiceSummary(card, month, today());
    }],
    ['POST', '/cards/:id/import/preview', ({ id, body }) => importPreview(id, body)],
    ['POST', '/cards/:id/import', ({ id, body }) => importItems(id, validMonth(body.month), body.items || [])],
    // contas fixas
    ['GET', '/recurrences', () => {
      const t = today();
      ensureMonth(D.ym(t));
      return db.all(`SELECT r.*, c.name AS category_name, c.color AS category_color,
                            a.name AS account_name, k.name AS card_name
                     FROM recurrences r
                     LEFT JOIN categories c ON c.id = r.category_id
                     LEFT JOIN accounts a ON a.id = r.account_id
                     LEFT JOIN cards k ON k.id = r.card_id
                     ORDER BY r.active DESC, r.kind DESC, COALESCE(r.day, 99), r.description`).map(r => recurrenceOut(r, t));
    }],
    ['POST', '/recurrences', ({ body }) => {
      const id = db.insert('recurrences', recurrenceData(body));
      ensureMonth(D.ym(today()));
      return recurrenceOut(fetchRow('recurrences', id), today());
    }],
    ['PUT', '/recurrences/:id', ({ id, body }) => {
      fetchRow('recurrences', id);
      db.update('recurrences', id, recurrenceData(body));
      clearFutureOccurrences(id);
      ensureMonth(D.ym(today()));
      return recurrenceOut(fetchRow('recurrences', id), today());
    }],
    ['DELETE', '/recurrences/:id', ({ id }) => {
      fetchRow('recurrences', id);
      clearFutureOccurrences(id);
      db.run('DELETE FROM recurrences WHERE id = ?', [id]);
      return null;
    }],
    // lançamentos
    ['GET', '/transactions', ({ q }) => {
      const month = validMonth(q.month);
      ensureMonth(month);
      const where = ['t.date BETWEEN ? AND ?'];
      const args = D.monthBounds(month);
      for (const [col, key] of [['t.kind', 'kind'], ['t.category_id', 'category_id'], ['t.account_id', 'account_id'], ['t.card_id', 'card_id']]) {
        if (q[key]) { where.push(`${col} = ?`); args.push(/_id$/.test(key) ? +q[key] : q[key]); }
      }
      if (q.q) { where.push('t.description LIKE ?'); args.push(`%${q.q}%`); }
      let sql = `SELECT * FROM (${TX_SELECT} WHERE ${where.join(' AND ')})`;
      if (q.status) { sql += ' WHERE paid = ?'; args.push(q.status === 'paid' ? 1 : 0); }
      return db.all(`${sql} ORDER BY date DESC, id DESC`, args).map(toDict);
    }],
    ['POST', '/transactions', ({ body }) => {
      const base = txFields(body);
      const n = Math.min(72, Math.max(1, body.installments || 1));
      const group = n > 1 ? crypto.randomUUID().replaceAll('-', '') : null;
      const each = body.amount_mode === 'installment' ? body.amount : Math.floor(body.amount / n);
      const rest = body.amount_mode === 'installment' ? 0 : body.amount - each * n;
      const ids = [];
      for (let i = 0; i < n; i++) {
        const data = { ...base, date: D.addMonths(body.date, i), amount: each + (i === 0 ? rest : 0) };
        if (n > 1) {
          Object.assign(data, { installment_group: group, installment_no: i + 1, installment_total: n });
          if (i > 0) Object.assign(data, { paid: false, paid_date: null });
        }
        if (body.card_id != null) data.invoice_month = D.shiftYm(base.invoice_month, i);
        ids.push(db.insert('transactions', data));
      }
      return ids.map(txOut);
    }],
    ['GET', '/transactions/:id', ({ id }) => txOut(id)],
    ['PUT', '/transactions/:id', ({ id, body }) => {
      fetchRow('transactions', id);
      db.update('transactions', id, { ...txFields(body), updated_at: new Date().toISOString().slice(0, 19) });
      return txOut(id);
    }],
    ['POST', '/transactions/:id/pay', ({ id, body }) => {
      const tx = fetchRow('transactions', id);
      if (tx.card_id != null) throw new HttpError(400, 'Lançamentos de cartão são quitados pelo pagamento da fatura');
      checkRefs({ account_id: body.account_id });
      const paid = body.paid ?? true;
      const data = { paid, paid_date: paid ? (body.paid_date || today()) : null };
      if (body.account_id != null) data.account_id = body.account_id;
      if (body.amount != null) data.amount = body.amount;
      db.update('transactions', id, data);
      return txOut(id);
    }],
    ['DELETE', '/transactions/:id', ({ id, q }) => {
      const tx = fetchRow('transactions', id);
      const scope = q.scope || 'one';
      let rows = [tx];
      if (tx.installment_group && scope !== 'one') {
        rows = scope === 'future'
          ? db.all('SELECT id, recurrence_id, recurrence_date FROM transactions WHERE installment_group = ? AND installment_no >= ?', [tx.installment_group, tx.installment_no])
          : db.all('SELECT id, recurrence_id, recurrence_date FROM transactions WHERE installment_group = ?', [tx.installment_group]);
      }
      for (const r of rows) {
        if (r.recurrence_id != null) db.run('INSERT OR IGNORE INTO recurrence_skips (recurrence_id, date) VALUES (?, ?)', [r.recurrence_id, r.recurrence_date]);
        db.run('DELETE FROM transactions WHERE id = ?', [r.id]);
      }
      return { deleted: rows.length };
    }],
    // resumo, lembretes, configurações
    ['GET', '/summary', ({ q }) => summary(validMonth(q.month), today())],
    ['GET', '/daily', ({ q }) => dailyGrid(validMonth(q.start), Math.min(24, Math.max(1, +(q.months || 12))))],
    ['GET', '/reminders', () => reminders(today())],
    ['GET', '/upcoming', ({ q }) => reminders(today(), Math.min(120, Math.max(1, +(q.days || 60))))],
    ['GET', '/settings', () => getSettings()],
    ['PUT', '/settings', ({ body }) => {
      for (const [k, v] of Object.entries(body)) {
        if (v != null) db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
      }
      return getSettings();
    }],
    ['POST', '/reset', ({ body }) => {
      if (body.confirm !== 'APAGAR') throw new HttpError(400, 'Para confirmar, envie {"confirm": "APAGAR"}');
      for (const t of DATA_TABLES) db.run(`DELETE FROM ${t}`);
      db.exec(seedSql);
      return { ok: true };
    }],
  ].map(([method, pattern, fn]) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    return { method, re, names, fn };
  });

  /** Executa uma requisição. Retorna { status, body }. Alterações rodam numa transação (tudo ou nada). */
  function handle(method, url, body = {}) {
    const [path, qs = ''] = url.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs));
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, n === 'id' ? +m[i + 1] : decodeURIComponent(m[i + 1])]));
      try {
        const result = db.tx(() => r.fn({ ...params, q, body: body || {} }));
        return { status: result === null ? 204 : method === 'POST' && !/\/(pay|reset|preview|import)$/.test(path) ? 201 : 200, body: result };
      } catch (e) {
        if (e instanceof HttpError) return { status: e.status, body: { detail: e.message } };
        throw e;
      }
    }
    return { status: 404, body: { detail: 'Not Found' } };
  }

  upgrade(db, schemaSql, seedSql, today());
  return { handle, db };
}

function defaultToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
