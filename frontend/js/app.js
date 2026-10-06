import { api, apiFetch, downloadBackup } from './api.js';
import {
  fmtMoney, parseMoney, centsToInput, todayISO, currentMonth, shiftMonth, monthLabel, monthShort,
  fmtDate, fmtDateFull, fmtDayHeader, daysUntil, dueLabel, esc, toast, storage, store,
} from './utils.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

const state = {
  month: currentMonth(),
  accounts: [], categories: [], cards: [], settings: {},
  txFilters: { kind: '', status: '', category_id: '', q: '' },
  invoiceMonth: {},
  txView: storage('txView', 'grid'),
  gridStart: currentMonth(),
  showPast: storage('showPast', false),
};

const BILL_TYPES = { fixa: 'Conta fixa', boleto: 'Boleto', assinatura: 'Assinatura', debito: 'Débito automático', outro: 'Outro' };
const FREQ = { monthly: 'Mensal', weekly: 'Semanal', yearly: 'Anual' };
const NATURES = {
  expense: [['daily', 'Gasto diário'], ['bill', 'Saída / conta'], ['saving', 'Economia (guardar)']],
  income: [['', 'Entrada'], ['saving', 'Resgate de economia']],
};
const natureOptions = (kind, selected) => NATURES[kind]
  .map(([v, l]) => `<option value="${v}" ${v === (selected ?? '') ? 'selected' : ''}>${l}</option>`).join('');
const ACCOUNT_TYPES = { checking: 'Conta corrente', savings: 'Poupança', wallet: 'Carteira', investment: 'Investimento', other: 'Outra' };
const INVOICE_STATUS = { aberta: ['Aberta', 'primary'], fechada: ['Fechada', 'warn'], paga: ['Paga', 'pos'], vencida: ['Vencida', 'danger'] };

// ======================================================================= dados de referência

async function loadRefs() {
  [state.accounts, state.categories, state.cards, state.settings] = await Promise.all([
    api.get('/accounts'), api.get('/categories'), api.get('/cards'), api.get('/settings'),
  ]);
}

async function refresh() {
  await loadRefs();
  await render();
  refreshReminders();
}

const num = v => (v === '' || v == null ? null : Number(v));
const activeAccounts = () => state.accounts.filter(a => !a.archived);
const activeCards = () => state.cards.filter(c => !c.archived);
const catById = id => state.categories.find(c => c.id === id);

function invoiceMonthFor(iso, closing, due) {
  const [y, m, d] = iso.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const ym = iso.slice(0, 7);
  const closingMonth = d < Math.min(closing, lastDay) ? ym : shiftMonth(ym, 1);
  return due > closing ? closingMonth : shiftMonth(closingMonth, 1);
}

// ======================================================================= componentes

function monthNav(month = state.month, attr = 'data-month') {
  return `<div class="month-nav">
    <button type="button" ${attr}="-1" aria-label="Mês anterior">‹</button>
    <span>${monthLabel(month)}</span>
    <button type="button" ${attr}="1" aria-label="Próximo mês">›</button>
  </div>`;
}
function bindMonthNav() {
  $$('[data-month]').forEach(b => b.onclick = () => {
    state.month = shiftMonth(state.month, +b.dataset.month);
    render();
  });
}

const catIcon = (name, color) =>
  `<div class="cat-ico" style="background:${esc(color || '#94a3b8')}">${esc((name || '?').slice(0, 1).toUpperCase())}</div>`;

function dateChip(iso) {
  const mon = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+iso.slice(5, 7) - 1];
  return `<div class="date-chip"><b>${iso.slice(8, 10)}</b><span>${mon}</span></div>`;
}

function dueTag(iso, paid) {
  if (paid) return '<span class="tag pos">pago</span>';
  const d = daysUntil(iso);
  const cls = d < 0 ? 'danger' : d <= 3 ? 'warn' : '';
  return `<span class="tag ${cls}">${dueLabel(d)}</span>`;
}

function categoryOptions(kind, selected) {
  const cats = state.categories.filter(c => c.kind === kind && (!c.archived || c.id === selected));
  return `<option value="">Sem categoria</option>` +
    cats.map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function sourceOptions(selected, { cards = true } = {}) {
  const accs = state.accounts.filter(a => !a.archived || selected === `a:${a.id}`);
  const crds = state.cards.filter(c => !c.archived || selected === `c:${c.id}`);
  const opt = (v, label) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(label)}</option>`;
  let html = `<optgroup label="Contas">${accs.map(a => opt(`a:${a.id}`, a.name)).join('')}</optgroup>`;
  if (cards && crds.length) html += `<optgroup label="Cartões de crédito">${crds.map(c => opt(`c:${c.id}`, `💳 ${c.name}`)).join('')}</optgroup>`;
  return html + opt('', '— sem conta —');
}
const parseSource = v => {
  const [t, id] = (v || '').split(':');
  return { account_id: t === 'a' ? +id : null, card_id: t === 'c' ? +id : null };
};
const defaultSource = () => (activeAccounts()[0] ? `a:${activeAccounts()[0].id}` : '');

function accountOptions(selected) {
  return `<option value="">— sem conta —</option>` + activeAccounts()
    .map(a => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
}

// ======================================================================= modal

function openModal({ title, body, submitLabel = 'Salvar', onSubmit, extraFoot = '', onOpen, cancelLabel = 'Cancelar' }) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form novalidate>
    <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Fechar">✕</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${extraFoot}
      <button type="button" class="btn" data-close>${cancelLabel}</button>
      ${onSubmit ? `<button type="submit" class="btn primary">${esc(submitLabel)}</button>` : ''}
    </div></form>`;
  const form = $('form', dlg);
  $$('[data-close]', dlg).forEach(b => b.onclick = () => dlg.close());
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      dlg.close();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };
  onOpen?.(form);
  dlg.showModal();
  const first = $('[autofocus]', form);
  if (first && !matchMedia('(max-width: 600px)').matches) first.focus();
  return form;
}

function choose(title, text, options) {
  return new Promise(resolve => {
    const foot = options.map((o, i) => `<button type="button" class="btn ${o.cls || ''}" data-choice="${i}">${esc(o.label)}</button>`).join('');
    openModal({ title, body: `<p>${esc(text)}</p>`, extraFoot: `<div class="left"></div>${foot}` });
    const dlg = $('#modal');
    $$('[data-choice]', dlg).forEach(b => b.onclick = () => { resolve(options[+b.dataset.choice].value); dlg.close(); });
    dlg.addEventListener('close', () => resolve(null), { once: true });
  });
}

// ======================================================================= formulários

function transactionForm(tx = null, defaults = {}) {
  const isEdit = !!tx;
  const t = tx || { kind: 'expense', date: todayISO(), nature: 'daily', ...defaults };
  const nature = t.nature ?? (isEdit && t.kind === 'expense' ? 'bill' : t.nature);
  const src = t.card_id ? `c:${t.card_id}` : t.account_id ? `a:${t.account_id}` : isEdit ? '' : defaultSource();
  const paid = isEdit ? t.paid : t.date <= todayISO();
  const installmentInfo = t.installment_total ? `<p class="hint full">Parcela ${t.installment_no}/${t.installment_total} — a edição vale só para esta parcela.</p>` : '';
  const recurrenceInfo = t.recurrence_id ? `<p class="hint full">↻ Gerado por uma conta fixa. Para mudar todos os meses, edite em <a href="#/fixas">Contas fixas</a>.</p>` : '';

  openModal({
    title: isEdit ? 'Editar lançamento' : 'Novo lançamento',
    extraFoot: isEdit ? '<button type="button" class="btn danger left" id="tx-del">Excluir</button>' : '',
    body: `<div class="form-grid">
      <div class="seg full">
        <label class="expense"><input type="radio" name="kind" value="expense" ${t.kind === 'expense' ? 'checked' : ''}>Despesa</label>
        <label class="income"><input type="radio" name="kind" value="income" ${t.kind === 'income' ? 'checked' : ''}>Receita</label>
      </div>
      <label class="field full"><span>Valor</span>
        <input name="amount" class="amount-input" inputmode="decimal" placeholder="0,00" value="${centsToInput(t.amount)}" autofocus required></label>
      <label class="field full"><span>Descrição</span><input name="description" value="${esc(t.description)}" placeholder="Ex.: Padaria, Uber, Farmácia" required maxlength="120"></label>
      <label class="field"><span>Data</span><input type="date" name="date" value="${t.date}" required></label>
      <label class="field"><span>Categoria</span><select name="category_id">${categoryOptions(t.kind, t.category_id)}</select></label>
      <label class="field"><span>Conta / cartão</span><select name="source">${sourceOptions(src)}</select></label>
      <label class="field" id="f-nature"><span>Classificação</span><select name="nature">${natureOptions(t.kind, nature)}</select></label>
      ${isEdit ? '' : `<label class="field" id="f-inst"><span>Parcelas</span><input type="number" name="installments" min="1" max="72" value="1"></label>
      <div class="full" id="f-amode" hidden>
        <div class="seg seg-sm">
          <label><input type="radio" name="amount_mode" value="total" checked>Informei o valor total</label>
          <label><input type="radio" name="amount_mode" value="installment">Informei o valor da parcela</label>
        </div>
        <p class="hint" id="inst-hint" style="margin:6px 2px 0"></p>
      </div>`}
      <p class="hint full" id="card-hint"></p>
      <label class="inline full" id="f-paid"><input type="checkbox" name="paid" ${paid ? 'checked' : ''}><span id="paid-label"></span></label>
      ${installmentInfo}${recurrenceInfo}
      <details class="full"><summary class="muted small">Mais opções</summary>
        <div class="form-grid" style="margin-top:10px">
          <label class="field"><span>Lembrar quantos dias antes</span><input type="number" name="reminder_days" min="0" max="60" value="${t.reminder_days ?? ''}" placeholder="padrão: ${state.settings.reminder_days_default}"></label>
          <label class="field full"><span>Observações</span><textarea name="notes" rows="2">${esc(t.notes)}</textarea></label>
        </div>
      </details>
    </div>`,
    onOpen(form) {
      let paidTouched = false;
      const sync = () => {
        const kind = form.kind.value;
        const { card_id } = parseSource(form.source.value);
        $('#paid-label', form).textContent = kind === 'income' ? 'Já recebi' : 'Já foi pago';
        $('#f-paid', form).hidden = !!card_id;
        $('#f-nature', form).hidden = !!card_id;
        const card = state.cards.find(c => c.id === card_id);
        $('#card-hint', form).textContent = card && form.date.value
          ? `💳 Entra na fatura de ${monthLabel(invoiceMonthFor(form.date.value, card.closing_day, card.due_day))} (vence dia ${card.due_day}).`
          : '';
      };
      $$('[name=kind]', form).forEach(r => r.onchange = () => {
        form.category_id.innerHTML = categoryOptions(form.kind.value, null);
        form.nature.innerHTML = natureOptions(form.kind.value, form.kind.value === 'expense' ? 'daily' : '');
        sync();
      });
      form.source.onchange = sync;
      const syncInst = () => {
        if (isEdit) return;
        const n = Math.max(1, +form.installments.value || 1);
        $('#f-amode', form).hidden = n < 2;
        const amount = parseMoney(form.amount.value);
        if (n < 2 || !(amount > 0)) { $('#inst-hint', form).textContent = ''; return; }
        const perInst = form.amount_mode.value === 'installment';
        const each = perInst ? amount : Math.floor(amount / n);
        const total = perInst ? amount * n : amount;
        $('#inst-hint', form).textContent = `${n}x de ${fmtMoney(each)} = ${fmtMoney(total)} no total`;
      };
      if (!isEdit) {
        form.installments.oninput = syncInst;
        form.amount.addEventListener('input', syncInst);
        $$('[name=amount_mode]', form).forEach(r => r.onchange = syncInst);
      }
      form.paid.onchange = () => { paidTouched = true; };
      form.date.onchange = () => {
        if (!isEdit && !paidTouched) form.paid.checked = form.date.value <= todayISO();
        sync();
      };
      sync();
      $('#tx-del', form)?.addEventListener('click', () => deleteTransaction(tx));
    },
    async onSubmit(fd) {
      const amount = parseMoney(fd.get('amount'));
      if (!(amount > 0)) throw new Error('Informe um valor válido');
      if (!fd.get('description').trim()) throw new Error('Informe uma descrição');
      const payload = {
        kind: fd.get('kind'),
        description: fd.get('description').trim(),
        amount,
        date: fd.get('date'),
        category_id: num(fd.get('category_id')),
        ...parseSource(fd.get('source')),
        paid: fd.get('paid') === 'on',
        reminder_days: num(fd.get('reminder_days')),
        notes: fd.get('notes') || null,
        nature: fd.get('nature') || null,
      };
      if (isEdit) {
        await api.put(`/transactions/${tx.id}`, payload);
        toast('Lançamento atualizado');
      } else {
        payload.installments = Math.max(1, +fd.get('installments') || 1);
        payload.amount_mode = fd.get('amount_mode') || 'total';
        const created = await api.post('/transactions', payload);
        toast(created.length > 1 ? `${created.length} parcelas lançadas` : 'Lançamento salvo');
      }
      refresh();
    },
  });
}

async function deleteTransaction(tx) {
  let scope = 'one';
  if (tx.installment_group) {
    scope = await choose('Excluir parcelado', `“${tx.description}” é a parcela ${tx.installment_no}/${tx.installment_total}.`, [
      { label: 'Só esta', value: 'one' },
      { label: 'Esta e as próximas', value: 'future' },
      { label: 'Todas', value: 'all', cls: 'danger' },
    ]);
  } else {
    const msg = tx.recurrence_id
      ? `Excluir “${tx.description}” só deste mês? (A conta fixa continua nos outros meses.)`
      : `Excluir “${tx.description}”?`;
    scope = await choose('Excluir lançamento', msg, [{ label: 'Excluir', value: 'one', cls: 'danger' }]);
  }
  if (!scope) return;
  try {
    const r = await api.del(`/transactions/${tx.id}?scope=${scope}`);
    toast(r.deleted > 1 ? `${r.deleted} lançamentos excluídos` : 'Lançamento excluído');
    refresh();
  } catch (e) { toast(e.message, 'error'); }
}

function payDialog(tx) {
  const income = tx.kind === 'income';
  openModal({
    title: income ? 'Confirmar recebimento' : 'Confirmar pagamento',
    submitLabel: income ? 'Recebido' : 'Pago',
    body: `<p><b>${esc(tx.description)}</b> <span class="muted">· vencimento ${fmtDateFull(tx.date)}</span></p>
      <div class="form-grid">
        <label class="field"><span>Valor ${income ? 'recebido' : 'pago'}</span><input name="amount" inputmode="decimal" value="${centsToInput(tx.amount)}" autofocus></label>
        <label class="field"><span>Data</span><input type="date" name="paid_date" value="${todayISO()}"></label>
        <label class="field full"><span>${income ? 'Recebido em' : 'Pago com'}</span><select name="account_id">${accountOptions(tx.account_id ?? activeAccounts()[0]?.id)}</select></label>
      </div>`,
    async onSubmit(fd) {
      const amount = parseMoney(fd.get('amount'));
      if (!(amount >= 0)) throw new Error('Valor inválido');
      await api.post(`/transactions/${tx.id}/pay`, { paid: true, amount, paid_date: fd.get('paid_date'), account_id: num(fd.get('account_id')) });
      toast(income ? 'Recebimento confirmado' : 'Pagamento registrado');
      refresh();
    },
  });
}

function invoicePayDialog(inv) {
  const card = state.cards.find(c => c.id === inv.card_id);
  openModal({
    title: `Pagar fatura ${inv.card_name || card?.name || ''}`,
    submitLabel: 'Registrar pagamento',
    body: `<p class="muted">Fatura de ${monthLabel(inv.month)} · vence ${fmtDateFull(inv.due_date)}</p>
      <div class="form-grid">
        <label class="field"><span>Valor pago</span><input name="amount" inputmode="decimal" value="${centsToInput(inv.total)}" autofocus></label>
        <label class="field"><span>Data</span><input type="date" name="paid_date" value="${todayISO()}"></label>
        <label class="field full"><span>Pago com</span><select name="account_id">${accountOptions(card?.account_id ?? activeAccounts()[0]?.id)}</select></label>
      </div>`,
    async onSubmit(fd) {
      const amount = parseMoney(fd.get('amount'));
      if (!(amount >= 0)) throw new Error('Valor inválido');
      await api.post(`/cards/${inv.card_id}/invoice/${inv.month}/pay`, { amount, paid_date: fd.get('paid_date'), account_id: num(fd.get('account_id')) });
      toast('Fatura paga');
      refresh();
    },
  });
}

async function togglePaid(tx) {
  try {
    await api.post(`/transactions/${tx.id}/pay`, { paid: !tx.paid });
    toast(tx.paid ? 'Marcado como pendente' : tx.kind === 'income' ? 'Recebido ✓' : 'Pago ✓');
    refresh();
  } catch (e) { toast(e.message, 'error'); }
}

function recurrenceForm(rec = null) {
  const isEdit = !!rec;
  const r = rec || { kind: 'expense', bill_type: 'fixa', frequency: 'monthly', start_date: todayISO(), active: true, day: new Date().getDate() };
  const src = r.card_id ? `c:${r.card_id}` : r.account_id ? `a:${r.account_id}` : isEdit ? '' : defaultSource();
  openModal({
    title: isEdit ? 'Editar conta fixa' : 'Nova conta fixa / recorrente',
    extraFoot: isEdit ? '<button type="button" class="btn danger left" id="rec-del">Excluir</button>' : '',
    body: `<div class="form-grid">
      <div class="seg full">
        <label class="expense"><input type="radio" name="kind" value="expense" ${r.kind === 'expense' ? 'checked' : ''}>Despesa</label>
        <label class="income"><input type="radio" name="kind" value="income" ${r.kind === 'income' ? 'checked' : ''}>Receita</label>
      </div>
      <label class="field full"><span>Descrição</span><input name="description" value="${esc(r.description)}" placeholder="Ex.: Aluguel, Internet, Netflix, Salário" required autofocus></label>
      <label class="field"><span>Valor <span class="hint">(estimado, se variar)</span></span><input name="amount" inputmode="decimal" value="${centsToInput(r.amount)}" placeholder="0,00" required></label>
      <label class="field"><span>Tipo</span><select name="bill_type">${Object.entries(BILL_TYPES).map(([k, v]) => `<option value="${k}" ${k === r.bill_type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>Classificação</span><select name="nature">${natureOptions(r.kind, r.nature ?? (r.kind === 'expense' ? 'bill' : ''))}</select></label>
      <label class="field"><span>Frequência</span><select name="frequency">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${k === r.frequency ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field" id="f-day"><span>Dia do vencimento</span><input type="number" name="day" min="1" max="31" value="${r.day ?? ''}"></label>
      <label class="field"><span>Categoria</span><select name="category_id">${categoryOptions(r.kind, r.category_id)}</select></label>
      <label class="field"><span>Conta / cartão</span><select name="source">${sourceOptions(src)}</select></label>
      <label class="field"><span>Começa em</span><input type="date" name="start_date" value="${r.start_date}" required></label>
      <label class="field"><span>Termina em <span class="hint">(opcional)</span></span><input type="date" name="end_date" value="${r.end_date ?? ''}"></label>
      <label class="field"><span>Lembrar quantos dias antes</span><input type="number" name="reminder_days" min="0" max="60" value="${r.reminder_days ?? ''}" placeholder="padrão: ${state.settings.reminder_days_default}"></label>
      <label class="inline" style="align-self:end;padding-bottom:10px"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Ativa</label>
      <label class="field full"><span>Observações</span><textarea name="notes" rows="2" placeholder="Ex.: código de barras, link do boleto...">${esc(r.notes)}</textarea></label>
      <p class="hint full">Os lançamentos são criados automaticamente a cada período. Ao editar, os meses futuros ainda não pagos são atualizados; o histórico pago é mantido.</p>
    </div>`,
    onOpen(form) {
      const syncFreq = () => { $('#f-day', form).hidden = form.frequency.value === 'weekly'; };
      form.frequency.onchange = syncFreq;
      syncFreq();
      $$('[name=kind]', form).forEach(x => x.onchange = () => {
        form.category_id.innerHTML = categoryOptions(form.kind.value, null);
        form.nature.innerHTML = natureOptions(form.kind.value, form.kind.value === 'expense' ? 'bill' : '');
      });
      $('#rec-del', form)?.addEventListener('click', async () => {
        const ok = await choose('Excluir conta fixa', `Excluir “${rec.description}”? Os lançamentos futuros não pagos serão removidos; o histórico pago fica.`, [{ label: 'Excluir', value: true, cls: 'danger' }]);
        if (!ok) return;
        await api.del(`/recurrences/${rec.id}`);
        toast('Conta fixa excluída');
        refresh();
      });
    },
    async onSubmit(fd) {
      const amount = parseMoney(fd.get('amount'));
      if (!(amount >= 0)) throw new Error('Informe um valor válido');
      const payload = {
        kind: fd.get('kind'), description: fd.get('description').trim(), amount,
        bill_type: fd.get('bill_type'), frequency: fd.get('frequency'),
        day: fd.get('frequency') === 'weekly' ? null : num(fd.get('day')),
        category_id: num(fd.get('category_id')), ...parseSource(fd.get('source')),
        start_date: fd.get('start_date'), end_date: fd.get('end_date') || null,
        reminder_days: num(fd.get('reminder_days')), active: fd.get('active') === 'on',
        notes: fd.get('notes') || null,
        nature: fd.get('nature') || null,
      };
      if (!payload.description) throw new Error('Informe uma descrição');
      if (isEdit) await api.put(`/recurrences/${rec.id}`, payload);
      else await api.post('/recurrences', payload);
      toast('Conta fixa salva');
      refresh();
    },
  });
}

function cardForm(card = null) {
  const isEdit = !!card;
  const c = card || { color: '#8b5cf6', closing_day: 1, due_day: 10 };
  openModal({
    title: isEdit ? 'Editar cartão' : 'Novo cartão de crédito',
    extraFoot: isEdit ? `<button type="button" class="btn danger left" id="card-del">${card.archived ? 'Reativar' : 'Excluir'}</button>` : '',
    body: `<div class="form-grid">
      <label class="field full"><span>Nome</span><input name="name" value="${esc(c.name)}" placeholder="Ex.: Nubank, Itaú Visa" required autofocus></label>
      <label class="field"><span>Limite</span><input name="credit_limit" inputmode="decimal" value="${centsToInput(c.credit_limit)}" placeholder="0,00"></label>
      <label class="field"><span>Cor</span><input type="color" name="color" value="${esc(c.color)}"></label>
      <label class="field"><span>Dia do fechamento</span><input type="number" name="closing_day" min="1" max="31" value="${c.closing_day}" required></label>
      <label class="field"><span>Dia do vencimento</span><input type="number" name="due_day" min="1" max="31" value="${c.due_day}" required></label>
      <label class="field"><span>Conta que paga a fatura</span><select name="account_id">${accountOptions(c.account_id ?? activeAccounts()[0]?.id)}</select></label>
      <label class="field"><span>Lembrar quantos dias antes</span><input type="number" name="reminder_days" min="0" max="60" value="${c.reminder_days ?? ''}" placeholder="padrão: ${state.settings.reminder_days_default}"></label>
      <p class="hint full">Compras feitas a partir do dia do fechamento entram na fatura seguinte.</p>
    </div>`,
    onOpen(form) {
      $('#card-del', form)?.addEventListener('click', async () => {
        if (card.archived) {
          await api.put(`/cards/${card.id}`, { ...pickCard(card), archived: false });
          toast('Cartão reativado');
        } else {
          const ok = await choose('Excluir cartão', `Excluir “${card.name}”? Se ele já tiver lançamentos, será apenas arquivado.`, [{ label: 'Excluir', value: true, cls: 'danger' }]);
          if (!ok) return;
          const r = await api.del(`/cards/${card.id}`);
          toast(r.archived ? 'Cartão arquivado' : 'Cartão excluído');
          location.hash = '#/cartoes';
        }
        $('#modal').close();
        refresh();
      });
    },
    async onSubmit(fd) {
      const payload = {
        name: fd.get('name').trim(), credit_limit: parseMoney(fd.get('credit_limit')) || 0, color: fd.get('color'),
        closing_day: +fd.get('closing_day'), due_day: +fd.get('due_day'),
        account_id: num(fd.get('account_id')), reminder_days: num(fd.get('reminder_days')), archived: !!card?.archived,
      };
      if (!payload.name) throw new Error('Informe o nome');
      if (isEdit) await api.put(`/cards/${card.id}`, payload);
      else await api.post('/cards', payload);
      toast('Cartão salvo');
      refresh();
    },
  });
}
const pickCard = c => ({ name: c.name, credit_limit: c.credit_limit, closing_day: c.closing_day, due_day: c.due_day, color: c.color, account_id: c.account_id, reminder_days: c.reminder_days });

function accountForm(acc = null) {
  const isEdit = !!acc;
  const a = acc || { type: 'checking', color: '#4f46e5', initial_balance: 0 };
  openModal({
    title: isEdit ? 'Editar conta' : 'Nova conta',
    extraFoot: isEdit ? '<button type="button" class="btn danger left" id="acc-del">Excluir</button>' : '',
    body: `<div class="form-grid">
      <label class="field full"><span>Nome</span><input name="name" value="${esc(a.name)}" placeholder="Ex.: Itaú, Nubank conta, Carteira" required autofocus></label>
      <label class="field"><span>Tipo</span><select name="type">${Object.entries(ACCOUNT_TYPES).map(([k, v]) => `<option value="${k}" ${k === a.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>Cor</span><input type="color" name="color" value="${esc(a.color)}"></label>
      <label class="field full"><span>Saldo inicial</span><input name="initial_balance" inputmode="decimal" value="${centsToInput(a.initial_balance)}"></label>
      <p class="hint full">O saldo atual = saldo inicial + receitas recebidas − despesas pagas − faturas pagas por esta conta.</p>
    </div>`,
    onOpen(form) {
      $('#acc-del', form)?.addEventListener('click', async () => {
        const ok = await choose('Excluir conta', `Excluir “${acc.name}”? Se tiver movimentações, será apenas arquivada.`, [{ label: 'Excluir', value: true, cls: 'danger' }]);
        if (!ok) return;
        const r = await api.del(`/accounts/${acc.id}`);
        toast(r.archived ? 'Conta arquivada' : 'Conta excluída');
        refresh();
      });
    },
    async onSubmit(fd) {
      const payload = {
        name: fd.get('name').trim(), type: fd.get('type'), color: fd.get('color'),
        initial_balance: parseMoney(fd.get('initial_balance')) || 0, archived: false,
      };
      if (!payload.name) throw new Error('Informe o nome');
      if (isEdit) await api.put(`/accounts/${acc.id}`, payload);
      else await api.post('/accounts', payload);
      toast('Conta salva');
      refresh();
    },
  });
}

function categoryForm(cat = null, kind = 'expense') {
  const isEdit = !!cat;
  const c = cat || { kind, color: '#64748b' };
  openModal({
    title: isEdit ? 'Editar categoria' : 'Nova categoria',
    extraFoot: isEdit ? '<button type="button" class="btn danger left" id="cat-del">Excluir</button>' : '',
    body: `<div class="form-grid">
      <label class="field full"><span>Nome</span><input name="name" value="${esc(c.name)}" required autofocus></label>
      <label class="field"><span>Tipo</span><select name="kind"><option value="expense" ${c.kind === 'expense' ? 'selected' : ''}>Despesa</option><option value="income" ${c.kind === 'income' ? 'selected' : ''}>Receita</option></select></label>
      <label class="field"><span>Cor</span><input type="color" name="color" value="${esc(c.color)}"></label>
    </div>`,
    onOpen(form) {
      $('#cat-del', form)?.addEventListener('click', async () => {
        const ok = await choose('Excluir categoria', `Excluir “${cat.name}”? Os lançamentos ficarão sem categoria.`, [{ label: 'Excluir', value: true, cls: 'danger' }]);
        if (!ok) return;
        await api.del(`/categories/${cat.id}`);
        toast('Categoria excluída');
        refresh();
      });
    },
    async onSubmit(fd) {
      const payload = { name: fd.get('name').trim(), kind: fd.get('kind'), color: fd.get('color'), icon: '', archived: false };
      if (!payload.name) throw new Error('Informe o nome');
      if (isEdit) await api.put(`/categories/${cat.id}`, payload);
      else await api.post('/categories', payload);
      toast('Categoria salva');
      refresh();
    },
  });
}

// ======================================================================= telas

async function Dashboard() {
  const s = await api.get(`/summary?month=${state.month}`);
  const kpi = (label, value, sub, cls = '') => `<div class="panel kpi">
    <div class="label">${label}</div><div class="value num ${cls}">${fmtMoney(value)}</div><div class="sub">${sub}</div></div>`;

  const items = [
    ...s.pending.map(p => ({ ...p, _type: 'tx', due: p.date })),
    ...s.invoices.filter(i => !i.paid && i.total > 0).map(i => ({ ...i, _type: 'inv', due: i.due_date, description: `Fatura ${i.card_name}`, amount: i.total, kind: 'expense' })),
  ].sort((a, b) => a.due.localeCompare(b.due));

  const pendingRow = (it, i) => `<div class="row">
    ${dateChip(it.due)}
    <div class="main-col">
      <div class="title">${esc(it.description)}</div>
      <div class="meta">${it._type === 'inv' ? '<span class="tag">💳 fatura</span>' : it.bill_type ? `<span class="tag">${BILL_TYPES[it.bill_type]}</span>` : ''}
        ${it.kind === 'income' ? '<span class="tag pos">a receber</span>' : dueTag(it.due, false)}</div>
    </div>
    <div class="side">
      <div class="amount num ${it.kind === 'income' ? 'pos' : ''}">${fmtMoney(it.amount)}</div>
      <button class="btn sm" data-pay="${i}">${it.kind === 'income' ? 'Receber' : 'Pagar'}</button>
    </div>
  </div>`;

  const maxCat = Math.max(1, ...s.by_category.map(c => c.total));
  const catTotal = s.by_category.reduce((a, c) => a + c.total, 0);

  view.innerHTML = `
    <div class="page-head"><h1>Resumo</h1>${monthNav()}</div>
    <section class="kpis">
      ${kpi('Receitas', s.income.total, `Recebido ${fmtMoney(s.income.received)}`, 'pos')}
      ${kpi('Despesas', s.expense.total, `Pago ${fmtMoney(s.expense.paid)}`, 'neg')}
      ${kpi('Saldo previsto do mês', s.balance_forecast, `Realizado ${fmtMoney(s.balance_realized)}`, s.balance_forecast < 0 ? 'neg' : '')}
      ${kpi('Saldo em contas', s.accounts_balance, 'Hoje, somando todas as contas')}
    </section>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>Pendências do mês</h2><span class="muted small">${items.length ? `${items.length} item(ns)` : ''}</span></div>
        <div class="list">${items.map(pendingRow).join('') || '<div class="empty">Tudo pago neste mês 🎉</div>'}</div>
      </section>
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><h2>Gastos por categoria</h2><span class="muted small num">${fmtMoney(catTotal)}</span></div>
          ${s.by_category.map(c => `<div class="cat-row">
            <div style="display:flex;align-items:center;gap:8px;min-width:0"><span class="dot" style="background:${esc(c.color)}"></span><span class="title">${esc(c.name)}</span></div>
            <div class="num">${fmtMoney(c.total)} <span class="muted small">${Math.round(c.total * 100 / (catTotal || 1))}%</span></div>
            <div class="bar"><div style="width:${(c.total * 100 / maxCat).toFixed(1)}%;background:${esc(c.color)}"></div></div>
          </div>`).join('') || '<div class="empty">Nenhum gasto neste mês</div>'}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Faturas que vencem no mês</h2><a href="#/cartoes" class="small">Ver cartões</a></div>
          <div class="list">${s.invoices.map(i => `<a class="row clickable" href="#/cartoes/${i.card_id}" data-inv-month="${i.month}" data-card="${i.card_id}">
            <span class="dot" style="background:${esc(i.color)}"></span>
            <div class="main-col"><div class="title">${esc(i.card_name)}</div><div class="meta">vence ${fmtDate(i.due_date)} <span class="tag ${INVOICE_STATUS[i.status][1]}">${INVOICE_STATUS[i.status][0]}</span></div></div>
            <div class="amount num">${fmtMoney(i.total)}</div></a>`).join('') || '<div class="empty">Nenhuma fatura neste mês</div>'}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Contas</h2><a href="#/config" class="small">Gerenciar</a></div>
          <div class="list">${activeAccounts().map(a => `<div class="row">
            <span class="dot" style="background:${esc(a.color)}"></span>
            <div class="main-col"><div class="title">${esc(a.name)}</div><div class="meta">${ACCOUNT_TYPES[a.type] || ''}</div></div>
            <div class="amount num ${a.balance < 0 ? 'neg' : ''}">${fmtMoney(a.balance)}</div></div>`).join('')}</div>
        </section>
      </div>
    </div>`;

  bindMonthNav();
  $$('[data-pay]').forEach(b => b.onclick = () => {
    const it = items[+b.dataset.pay];
    it._type === 'inv' ? invoicePayDialog(it) : payDialog(it);
  });
  $$('[data-inv-month]').forEach(a => a.addEventListener('click', () => {
    state.invoiceMonth[a.dataset.card] = a.dataset.invMonth;
  }));
}

function viewToggle() {
  return `<div class="seg seg-sm">
    <label><input type="radio" name="txview" value="grid" ${state.txView === 'grid' ? 'checked' : ''}>Grade</label>
    <label><input type="radio" name="txview" value="list" ${state.txView === 'list' ? 'checked' : ''}>Lista</label>
  </div>`;
}
function bindViewToggle() {
  $$('[name=txview]').forEach(r => r.onchange = () => { state.txView = r.value; store('txView', r.value); render(); });
}

async function Transactions() {
  if (state.txView === 'grid') return Grid();
  const f = state.txFilters;
  view.innerHTML = `
    <div class="page-head"><h1>Lançamentos</h1><div class="head-tools">${viewToggle()}${monthNav()}</div></div>
    <section class="kpis three" id="tx-kpis"></section>
    <section class="panel">
      <div class="filters">
        <input type="search" id="f-q" placeholder="Buscar descrição..." value="${esc(f.q)}">
        <select id="f-kind"><option value="">Receitas e despesas</option><option value="expense">Só despesas</option><option value="income">Só receitas</option></select>
        <select id="f-status"><option value="">Todos</option><option value="pending">Pendentes</option><option value="paid">Pagos / recebidos</option></select>
        <select id="f-cat"><option value="">Todas as categorias</option>${state.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      </div>
      <div class="list" id="tx-list"><div class="empty">Carregando...</div></div>
    </section>`;
  bindMonthNav();
  bindViewToggle();
  $('#f-kind').value = f.kind; $('#f-status').value = f.status; $('#f-cat').value = f.category_id;
  let timer;
  $('#f-q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value; loadTxList(); }, 250); };
  $('#f-kind').onchange = e => { f.kind = e.target.value; loadTxList(); };
  $('#f-status').onchange = e => { f.status = e.target.value; loadTxList(); };
  $('#f-cat').onchange = e => { f.category_id = e.target.value; loadTxList(); };
  await loadTxList();
}

// ----------------------------------------------------------------------- grade de saldos

const GRID_MONTHS = 12;
const GRID_COLS = [
  { key: 'income', label: 'entradas', ico: '↙', color: '#22c55e', defaults: { kind: 'income', nature: null } },
  { key: 'bills', label: 'saídas', ico: '↗', color: '#ef4444', defaults: { kind: 'expense', nature: 'bill' } },
  { key: 'daily', label: 'diários', ico: 'D', color: '#ec4899', defaults: { kind: 'expense', nature: 'daily' } },
  { key: 'savings', label: 'economias', ico: 'E', color: '#84cc16', defaults: { kind: 'expense', nature: 'saving' } },
  { key: 'card', label: 'cartão', ico: 'C', color: '#8b5cf6' },
];
const gridColOf = t => (t.card_id ? 'card'
  : t.kind === 'income' ? (t.nature === 'saving' ? 'savings' : 'income')
  : t.nature === 'daily' ? 'daily' : t.nature === 'saving' ? 'savings' : 'bills');
const gico = (c, dim = false) => `<span class="gico ${dim ? 'dim' : ''}" style="--c:${c.color}">${c.ico}</span>`;

async function Grid() {
  const end = shiftMonth(state.gridStart, GRID_MONTHS - 1);
  const old = $('.grid-scroll');
  const keepScroll = old && old.dataset.start === state.gridStart ? [old.scrollLeft, old.scrollTop] : null;
  if (!old) view.innerHTML = '<div class="empty">Carregando...</div>';
  const g = await api.get(`/daily?start=${state.gridStart}&months=${GRID_MONTHS}`);
  const today = todayISO(), cur = currentMonth();

  const table = m => {
    const days = m.month === cur && !state.showPast ? m.days.filter(d => d.date >= today) : m.days;
    const rows = days.map(d => {
      const wd = new Date(d.date + 'T12:00:00').getDay();
      return `<tr class="${d.date === today ? 'today' : ''} ${wd === 0 || wd === 6 ? 'weekend' : ''}">
        <td class="gday">${+d.date.slice(8)}</td>
        ${GRID_COLS.map(c => `<td class="gc ${d[c.key] ? '' : 'zero'}" data-cell="${c.key}" data-date="${d.date}"><div class="gin">${gico(c, !d[c.key])}<span class="num">${fmtMoney(d[c.key])}</span></div></td>`).join('')}
        <td class="gbal ${d.balance < 0 ? 'neg' : ''}"><span class="num">${fmtMoney(d.balance)}</span></td>
      </tr>`;
    }).join('');
    return `<div class="gm"><table class="gtable">
      <thead>
        <tr><th colspan="7" class="gtitle">${monthLabel(m.month).toLowerCase().replace(' ', ' de ')}</th></tr>
        <tr><th>dia</th>${GRID_COLS.map(c => `<th><div class="gin">${gico(c)}<span>${c.label}</span></div></th>`).join('')}<th>saldos</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td></td>${GRID_COLS.map(c => `<td><div class="gin">${gico(c, !m.totals[c.key])}<span class="num">${fmtMoney(m.totals[c.key])}</span></div></td>`).join('')}
        <td class="gbal ${m.end_balance < 0 ? 'neg' : ''}"><span class="num">${fmtMoney(m.end_balance)}</span></td></tr></tfoot>
    </table></div>`;
  };

  view.innerHTML = `
    <div class="page-head grid-head"><h1>Lançamentos</h1>
      <div class="head-tools">
        ${viewToggle()}
        <div class="month-nav">
          <button type="button" data-gshift="-12" aria-label="Voltar 12 meses">«</button>
          <button type="button" data-gshift="-1" aria-label="Mês anterior">‹</button>
          <span>${monthShort(state.gridStart)} – ${monthShort(end)}</span>
          <button type="button" data-gshift="1" aria-label="Próximo mês">›</button>
          <button type="button" data-gshift="12" aria-label="Avançar 12 meses">»</button>
        </div>
        <button class="btn sm" id="g-today">Hoje</button>
        <label class="inline small"><input type="checkbox" id="g-past" ${state.showPast ? 'checked' : ''}> dias passados</label>
      </div>
    </div>
    <div class="grid-scroll" data-start="${state.gridStart}">${g.months.map(table).join('')}</div>
    <p class="hint">Clique em qualquer célula para ver ou adicionar lançamentos naquele dia. O saldo é projetado: considera tudo o que está lançado na data, pago ou não, e cada fatura no dia do vencimento.</p>`;

  const sc = $('.grid-scroll');
  if (keepScroll) [sc.scrollLeft, sc.scrollTop] = keepScroll;
  $$('[data-gshift]').forEach(b => b.onclick = () => { state.gridStart = shiftMonth(state.gridStart, +b.dataset.gshift); render(); });
  $('#g-today').onclick = () => {
    state.gridStart = currentMonth();
    render().then(() => { const s2 = $('.grid-scroll'); if (s2) { s2.scrollLeft = 0; s2.scrollTop = 0; } });
  };
  $('#g-past').onchange = e => { state.showPast = e.target.checked; store('showPast', state.showPast); render(); };
  bindViewToggle();
  $$('[data-cell]', sc).forEach(td => td.onclick = () => openCell(td.dataset.cell, td.dataset.date));
}

async function openCell(key, date) {
  const col = GRID_COLS.find(c => c.key === key);
  const month = date.slice(0, 7);
  const title = `${col.label[0].toUpperCase()}${col.label.slice(1)} — ${fmtDayHeader(date)}`;

  if (key === 'card') {
    const s = await api.get(`/summary?month=${month}`);
    const invs = s.invoices.filter(i => i.due_date === date);
    const firstCard = activeCards()[0];
    if (!invs.length) {
      if (!firstCard) return toast('Cadastre um cartão em Cartões', 'error');
      return transactionForm(null, { date, card_id: firstCard.id, nature: null });
    }
    openModal({
      title, cancelLabel: 'Fechar',
      body: `<div class="list">${invs.map((i, n) => `<div class="row">
        <span class="dot" style="background:${esc(i.color)}"></span>
        <div class="main-col"><div class="title">Fatura ${esc(i.card_name)}</div>
          <div class="meta"><span class="tag ${INVOICE_STATUS[i.status][1]}">${INVOICE_STATUS[i.status][0]}</span> <a href="#/cartoes/${i.card_id}" data-goinv="${n}">ver compras</a></div></div>
        <div class="side"><div class="amount num">${fmtMoney(i.total)}</div>
          ${i.paid ? '' : `<button type="button" class="btn sm" data-payinv="${n}">Pagar</button>`}</div>
      </div>`).join('')}</div>`,
      extraFoot: firstCard ? '<button type="button" class="btn left" id="cell-add">+ Compra no cartão</button>' : '',
      onOpen(form) {
        $$('[data-goinv]', form).forEach(a => a.onclick = () => { state.invoiceMonth[invs[+a.dataset.goinv].card_id] = month; $('#modal').close(); });
        $$('[data-payinv]', form).forEach(b => b.onclick = () => invoicePayDialog(invs[+b.dataset.payinv]));
        $('#cell-add', form)?.addEventListener('click', () => transactionForm(null, { date, card_id: firstCard.id, nature: null }));
      },
    });
    return;
  }

  const txs = (await api.get(`/transactions?month=${month}`)).filter(t => t.date === date && gridColOf(t) === key);
  const defaults = { date, ...col.defaults };
  if (!txs.length) return transactionForm(null, defaults);
  const total = txs.reduce((a, t) => a + (key === 'savings' && t.kind === 'income' ? -t.amount : t.amount), 0);
  openModal({
    title, cancelLabel: 'Fechar',
    body: `<div class="list">${txs.map((t, i) => `<div class="row clickable ${t.paid ? 'done' : ''}" data-ctx="${i}">
        ${catIcon(t.category_name, t.category_color)}
        <div class="main-col"><div class="title">${esc(t.description)}</div>
          <div class="meta">${esc(t.category_name || 'sem categoria')}${t.account_name ? ` · ${esc(t.account_name)}` : ''}
            ${t.recurrence_id ? ' · <span class="tag primary">↻ fixa</span>' : ''}
            ${t.installment_total ? ` · <span class="tag">${t.installment_no}/${t.installment_total}</span>` : ''}
            ${t.nature === 'saving' && t.kind === 'income' ? ' · <span class="tag">resgate</span>' : ''}</div></div>
        <div class="amount num ${t.kind === 'income' ? 'pos' : ''}">${fmtMoney(t.amount)}</div>
        <button type="button" class="check ${t.paid ? 'on' : ''}" data-ctoggle="${i}" title="${t.paid ? 'Desmarcar' : 'Marcar como pago'}">✓</button>
      </div>`).join('')}</div>
      <p class="small" style="text-align:right;margin:10px 4px 0">Total <b class="num">${fmtMoney(total)}</b></p>`,
    extraFoot: '<button type="button" class="btn primary left" id="cell-add">+ Adicionar</button>',
    onOpen(form) {
      $$('[data-ctx]', form).forEach(r => r.onclick = e => {
        if (e.target.closest('[data-ctoggle]')) return;
        transactionForm(txs[+r.dataset.ctx]);
      });
      $$('[data-ctoggle]', form).forEach(b => b.onclick = () => { $('#modal').close(); togglePaid(txs[+b.dataset.ctoggle]); });
      $('#cell-add', form).onclick = () => transactionForm(null, defaults);
    },
  });
}

async function loadTxList() {
  const f = state.txFilters;
  const params = new URLSearchParams({ month: state.month });
  if (f.kind) params.set('kind', f.kind);
  if (f.status) params.set('status', f.status);
  if (f.category_id) params.set('category_id', f.category_id);
  if (f.q) params.set('q', f.q);
  const txs = await api.get(`/transactions?${params}`);
  const list = $('#tx-list');
  if (!list) return;

  const inc = txs.filter(t => t.kind === 'income').reduce((a, t) => a + t.amount, 0);
  const exp = txs.filter(t => t.kind === 'expense').reduce((a, t) => a + t.amount, 0);
  $('#tx-kpis').innerHTML = `
    <div class="panel kpi"><div class="label">Entradas</div><div class="value num pos">${fmtMoney(inc)}</div></div>
    <div class="panel kpi"><div class="label">Saídas</div><div class="value num neg">${fmtMoney(exp)}</div></div>
    <div class="panel kpi"><div class="label">Diferença</div><div class="value num ${inc - exp < 0 ? 'neg' : ''}">${fmtMoney(inc - exp)}</div></div>`;

  if (!txs.length) {
    list.innerHTML = '<div class="empty">Nenhum lançamento. Toque em <b>+</b> para adicionar.</div>';
    return;
  }
  let html = '', lastDate = '';
  txs.forEach((t, i) => {
    if (t.date !== lastDate) { html += `<div class="day-group">${fmtDayHeader(t.date)}</div>`; lastDate = t.date; }
    const meta = [
      t.category_name ? esc(t.category_name) : '<span class="muted">sem categoria</span>',
      t.card_name ? `💳 ${esc(t.card_name)} · fatura ${monthShort(t.invoice_month)}` : esc(t.account_name || ''),
      t.installment_total ? `<span class="tag">${t.installment_no}/${t.installment_total}</span>` : '',
      t.recurrence_id ? `<span class="tag primary">↻ ${BILL_TYPES[t.bill_type] || 'fixa'}</span>` : '',
      !t.paid && !t.card_id ? (t.kind === 'income' ? '<span class="tag pos">a receber</span>' : dueTag(t.date, false)) : '',
    ].filter(Boolean).join(' · ');
    html += `<div class="row clickable ${t.paid ? 'done' : ''}" data-tx="${i}">
      ${catIcon(t.category_name, t.category_color)}
      <div class="main-col"><div class="title">${esc(t.description)}</div><div class="meta">${meta}</div></div>
      <div class="amount num ${t.kind === 'income' ? 'pos' : ''}">${t.kind === 'income' ? '+' : '−'} ${fmtMoney(t.amount)}</div>
      ${t.card_id ? `<span class="check ${t.paid ? 'on' : ''}" title="${t.paid ? 'Fatura paga' : 'Pago na fatura'}" style="cursor:default;border-style:${t.paid ? 'solid' : 'dashed'}">${t.paid ? '✓' : ''}</span>`
        : `<button class="check ${t.paid ? 'on' : ''}" data-toggle="${i}" title="${t.paid ? 'Desmarcar' : 'Marcar como pago'}">✓</button>`}
    </div>`;
  });
  list.innerHTML = html;
  $$('[data-tx]', list).forEach(r => r.onclick = e => {
    if (e.target.closest('[data-toggle]')) return;
    transactionForm(txs[+r.dataset.tx]);
  });
  $$('[data-toggle]', list).forEach(b => b.onclick = () => togglePaid(txs[+b.dataset.toggle]));
}

async function Recurrences() {
  const recs = await api.get('/recurrences');
  const factor = { monthly: 1, weekly: 52 / 12, yearly: 1 / 12 };
  const monthly = kind => recs.filter(r => r.active && r.kind === kind).reduce((a, r) => a + r.amount * factor[r.frequency], 0);
  const fixedExp = monthly('expense'), fixedInc = monthly('income');

  const row = r => {
    const when = r.frequency === 'weekly' ? 'semanal' : r.frequency === 'yearly' ? `anual · dia ${r.day ?? r.start_date.slice(8)}/${r.start_date.slice(5, 7)}` : `todo dia ${r.day ?? +r.start_date.slice(8)}`;
    const cur = r.current;
    const status = !r.active ? '<span class="tag">inativa</span>'
      : cur?.card_id ? '<span class="tag">💳 na fatura</span>'
      : cur ? (cur.paid ? '<span class="tag pos">pago este mês</span>' : dueTag(cur.date, false))
      : r.next_date ? `<span class="tag">próxima ${fmtDate(r.next_date)}</span>` : '';
    return `<div class="row clickable" data-rec="${r.id}" style="${r.active ? '' : 'opacity:.6'}">
      ${catIcon(r.category_name || r.description, r.category_color)}
      <div class="main-col">
        <div class="title">${esc(r.description)}</div>
        <div class="meta"><span class="tag primary">${BILL_TYPES[r.bill_type]}</span> ${when} · ${r.card_name ? `💳 ${esc(r.card_name)}` : esc(r.account_name || 'sem conta')} ${status}</div>
      </div>
      <div class="amount num ${r.kind === 'income' ? 'pos' : ''}">${fmtMoney(r.amount)}</div>
    </div>`;
  };
  const section = (title, list) => list.length ? `<section class="panel"><h2>${title}</h2><div class="list">${list.map(row).join('')}</div></section>` : '';

  view.innerHTML = `
    <div class="page-head"><h1>Contas fixas e recorrentes</h1><button class="btn primary" id="rec-new">+ Nova conta fixa</button></div>
    <section class="kpis three">
      <div class="panel kpi"><div class="label">Despesas fixas / mês</div><div class="value num neg">${fmtMoney(fixedExp)}</div></div>
      <div class="panel kpi"><div class="label">Receitas fixas / mês</div><div class="value num pos">${fmtMoney(fixedInc)}</div></div>
      <div class="panel kpi"><div class="label">Sobra após fixos</div><div class="value num ${fixedInc - fixedExp < 0 ? 'neg' : ''}">${fmtMoney(fixedInc - fixedExp)}</div></div>
    </section>
    <div class="stack">
      ${section('Despesas', recs.filter(r => r.active && r.kind === 'expense'))}
      ${section('Receitas', recs.filter(r => r.active && r.kind === 'income'))}
      ${section('Inativas', recs.filter(r => !r.active))}
      ${recs.length ? '' : `<section class="panel empty">
        Cadastre aqui aluguel, condomínio, luz, internet, assinaturas, boletos, salário...<br>
        Eles aparecem sozinhos todo mês nos lançamentos, com lembrete antes do vencimento.</section>`}
    </div>`;
  $('#rec-new').onclick = () => recurrenceForm();
  $$('[data-rec]').forEach(el => el.onclick = () => recurrenceForm(recs.find(r => r.id === +el.dataset.rec)));
}

async function Cards(id) {
  if (id) return CardDetail(+id);
  const cards = await api.get('/cards');
  const tile = c => {
    const inv = c.current_invoice;
    const [label, cls] = INVOICE_STATUS[inv.status];
    const pct = c.credit_limit ? Math.min(100, (c.used_limit * 100) / c.credit_limit) : 0;
    return `<a class="panel card-tile" href="#/cartoes/${c.id}" style="${c.archived ? 'opacity:.55' : ''}">
      <div class="stripe" style="background:${esc(c.color)}"></div>
      <div class="panel-head"><h2>${esc(c.name)}</h2><span class="tag ${cls}">${label}</span></div>
      <div class="muted small">Fatura de ${monthLabel(inv.month)}</div>
      <div class="num" style="font-size:1.5rem;font-weight:700;color:var(--text);margin:2px 0 6px">${fmtMoney(inv.total)}</div>
      <div class="muted small">fecha ${fmtDate(inv.closing_date)} · vence ${fmtDate(inv.due_date)}</div>
      ${c.credit_limit ? `<div style="margin-top:14px"><div class="bar"><div style="width:${pct}%;background:${esc(c.color)}"></div></div>
        <div class="muted small" style="margin-top:6px;display:flex;justify-content:space-between"><span>Usado ${fmtMoney(c.used_limit)}</span><span>Disponível ${fmtMoney(c.available_limit)}</span></div></div>` : ''}
      ${c.archived ? '<div class="tag" style="margin-top:8px">arquivado</div>' : ''}
    </a>`;
  };
  view.innerHTML = `
    <div class="page-head"><h1>Cartões de crédito</h1><button class="btn primary" id="card-new">+ Novo cartão</button></div>
    <div class="grid-3">${cards.map(tile).join('')}</div>
    ${cards.length ? '' : '<section class="panel empty">Cadastre seus cartões para acompanhar as faturas, parcelas e o limite disponível.</section>'}`;
  $('#card-new').onclick = () => cardForm();
}

async function CardDetail(id) {
  const card = state.cards.find(c => c.id === id);
  if (!card) { view.innerHTML = '<div class="empty">Cartão não encontrado. <a href="#/cartoes">Voltar</a></div>'; return; }
  const month = state.invoiceMonth[id] || card.current_invoice.month;
  const inv = await api.get(`/cards/${id}/invoice?month=${month}`);
  const [label, cls] = INVOICE_STATUS[inv.status];

  view.innerHTML = `
    <div class="page-head">
      <div style="display:flex;align-items:center;gap:10px"><a href="#/cartoes" class="btn ghost sm">‹ Cartões</a>
        <h1><span class="dot" style="display:inline-block;background:${esc(card.color)};margin-right:8px"></span>${esc(card.name)}</h1></div>
      <div style="display:flex;gap:8px;align-items:center">${monthNav(month, 'data-inv')}<button class="btn" id="card-edit">Editar</button></div>
    </div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>Fatura de ${monthLabel(month)}</h2><span class="tag ${cls}">${label}</span></div>
        <div class="num" style="font-size:2rem;font-weight:700;margin:4px 0">${fmtMoney(inv.total)}</div>
        <div class="muted small">Fecha em ${fmtDateFull(inv.closing_date)} · vence em ${fmtDateFull(inv.due_date)}</div>
        ${inv.paid ? `<p class="small">✓ Paga em ${fmtDateFull(inv.paid_date)} — ${fmtMoney(inv.paid_amount)}</p>` : ''}
        <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
          ${inv.paid ? '<button class="btn" id="inv-unpay">Desfazer pagamento</button>' : `<button class="btn primary" id="inv-pay" ${inv.total <= 0 ? 'disabled' : ''}>Pagar fatura</button>`}
          <button class="btn" id="inv-add">+ Compra neste cartão</button>
        </div>
      </section>
      <section class="panel">
        <h2>Limite</h2>
        ${card.credit_limit ? `<div class="bar"><div style="width:${Math.min(100, card.used_limit * 100 / card.credit_limit)}%;background:${esc(card.color)}"></div></div>
          <div style="display:flex;justify-content:space-between;margin-top:8px" class="small"><span>Usado <b class="num">${fmtMoney(card.used_limit)}</b></span><span>Disponível <b class="num">${fmtMoney(card.available_limit)}</b></span></div>
          <p class="hint">Limite total ${fmtMoney(card.credit_limit)} · inclui parcelas futuras.</p>` : '<p class="muted small">Sem limite cadastrado.</p>'}
        <p class="hint">Fecha dia ${card.closing_day} · vence dia ${card.due_day}</p>
      </section>
    </div>
    <section class="panel" style="margin-top:16px">
      <h2>Lançamentos da fatura <span class="muted small">(${inv.items.length})</span></h2>
      <div class="list">${inv.items.map((t, i) => `<div class="row clickable" data-item="${i}">
        ${catIcon(t.category_name, t.category_color)}
        <div class="main-col"><div class="title">${esc(t.description)}</div>
          <div class="meta">${fmtDate(t.date)} · ${esc(t.category_name || 'sem categoria')}
            ${t.installment_total ? ` · <span class="tag">${t.installment_no}/${t.installment_total}</span>` : ''}
            ${t.recurrence_id ? ' · <span class="tag primary">↻ recorrente</span>' : ''}</div></div>
        <div class="amount num ${t.kind === 'income' ? 'pos' : ''}">${t.kind === 'income' ? '− ' : ''}${fmtMoney(t.amount)}</div>
      </div>`).join('') || '<div class="empty">Nenhuma compra nesta fatura</div>'}</div>
    </section>`;

  $$('[data-inv]').forEach(b => b.onclick = () => { state.invoiceMonth[id] = shiftMonth(month, +b.dataset.inv); render(); });
  $('#card-edit').onclick = () => cardForm(card);
  $('#inv-add').onclick = () => transactionForm(null, { card_id: id });
  $('#inv-pay')?.addEventListener('click', () => invoicePayDialog({ ...inv, card_name: card.name }));
  $('#inv-unpay')?.addEventListener('click', async () => {
    await api.del(`/cards/${id}/invoice/${month}/pay`);
    toast('Pagamento desfeito');
    refresh();
  });
  $$('[data-item]').forEach(r => r.onclick = () => transactionForm({ ...inv.items[+r.dataset.item], card_id: id }));
}

async function Settings() {
  const s = state.settings;
  const notifSupported = 'Notification' in window;
  const notifOn = storage('browserNotify', false) && notifSupported && Notification.permission === 'granted';
  const catChips = kind => state.categories.filter(c => c.kind === kind).map(c =>
    `<button class="btn sm" data-cat="${c.id}"><span class="color-swatch" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('');

  view.innerHTML = `
    <div class="page-head"><h1>Ajustes</h1></div>
    <div class="grid-2">
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><h2>Contas</h2><button class="btn sm" id="acc-new">+ Nova conta</button></div>
          <div class="list">${state.accounts.map(a => `<div class="row clickable" data-acc="${a.id}" style="${a.archived ? 'opacity:.55' : ''}">
            <span class="dot" style="background:${esc(a.color)}"></span>
            <div class="main-col"><div class="title">${esc(a.name)}</div><div class="meta">${ACCOUNT_TYPES[a.type] || ''}${a.archived ? ' · arquivada' : ''}</div></div>
            <div class="amount num ${a.balance < 0 ? 'neg' : ''}">${fmtMoney(a.balance)}</div></div>`).join('')}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Categorias</h2><button class="btn sm" id="cat-new">+ Nova</button></div>
          <p class="muted small" style="margin:4px 0 8px">Despesas</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${catChips('expense')}</div>
          <p class="muted small" style="margin:14px 0 8px">Receitas</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${catChips('income')}</div>
        </section>
      </div>
      <div class="stack">
        <section class="panel">
          <h2>Lembretes</h2>
          <form id="rem-form" class="form-grid">
            <label class="field"><span>Avisar quantos dias antes (padrão)</span><input type="number" name="reminder_days_default" min="0" max="60" value="${s.reminder_days_default}"></label>
            <label class="field"><span>Horário do aviso diário (celular)</span><select name="notify_hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === s.notify_hour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
            <p class="hint full">Cada conta fixa, cartão ou lançamento pode ter sua própria antecedência; se ficar em branco, vale este padrão.</p>
            <div class="full"><button class="btn primary" type="submit">Salvar</button></div>
          </form>
        </section>
        <section class="panel">
          <h2>Notificações no navegador</h2>
          <p class="muted small">Mostra um aviso no computador quando houver contas vencendo (com esta página aberta).</p>
          ${notifSupported ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn ${notifOn ? '' : 'primary'}" id="notif-toggle">${notifOn ? 'Desativar' : 'Ativar notificações'}</button>
            ${notifOn ? '<button class="btn" id="notif-test">Testar</button>' : ''}</div>` : '<p class="small">Este navegador não suporta notificações.</p>'}
        </section>
        <section class="panel">
          <h2>Notificações no celular (ntfy)</h2>
          <p class="muted small">Enquanto o app Android não existe: instale o app gratuito <b>ntfy</b> no celular, inscreva-se em um tópico com nome difícil de adivinhar e coloque o mesmo nome aqui. Uma vez por dia, no horário acima, o servidor envia o resumo das contas.</p>
          <form id="ntfy-form" class="form-grid">
            <label class="field"><span>Servidor</span><input name="ntfy_server" value="${esc(s.ntfy_server)}"></label>
            <label class="field"><span>Tópico</span><input name="ntfy_topic" value="${esc(s.ntfy_topic)}" placeholder="ex.: financas-yuri-8f3k2"></label>
            <label class="inline full"><input type="checkbox" name="ntfy_enabled" ${s.ntfy_enabled ? 'checked' : ''}> Enviar lembretes diários</label>
            <div class="full" style="display:flex;gap:8px"><button class="btn primary" type="submit">Salvar</button><button class="btn" type="button" id="ntfy-test">Enviar teste agora</button></div>
          </form>
        </section>
        <section class="panel">
          <h2>Dados</h2>
          <p class="muted small">Baixe uma cópia de segurança de tudo (lançamentos, contas, cartões e configurações) ou restaure uma cópia baixada antes.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" data-backup>Baixar backup</button>
            <button class="btn" id="restore-btn">Importar backup</button>
            <input type="file" id="restore-file" accept=".db,.sqlite,.sqlite3,application/octet-stream" hidden>
            <button class="btn danger" id="reset-all">Zerar todos os dados</button>
          </div>
        </section>
        <section class="panel">
          <h2>API</h2>
          <p class="muted small">Toda a interface usa a API REST — a mesma que o app Android vai consumir. Documentação interativa: <a href="/docs" target="_blank">/docs</a></p>
        </section>
      </div>
    </div>`;

  $('#acc-new').onclick = () => accountForm();
  $('#restore-btn').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) restoreDialog(file);
  };
  $('#reset-all').onclick = () => openModal({
    title: 'Zerar todos os dados',
    submitLabel: 'Apagar tudo',
    body: `<p>Isso apaga <b>todos</b> os lançamentos, contas fixas, cartões, faturas, contas e categorias.
        As categorias e a conta padrão são recriadas; as configurações de lembretes são mantidas.</p>
      <p class="muted small">Não dá para desfazer. Se quiser, <a href="#" data-backup>baixe um backup</a> antes.</p>
      <label class="field"><span>Digite <b>APAGAR</b> para confirmar</span><input name="confirm" autocomplete="off" autofocus></label>`,
    onOpen(form) {
      const btn = $('[type=submit]', form);
      btn.classList.replace('primary', 'danger');
      btn.disabled = true;
      form.confirm.oninput = () => { btn.disabled = form.confirm.value.trim() !== 'APAGAR'; };
    },
    async onSubmit(fd) {
      await api.post('/reset', { confirm: fd.get('confirm').trim() });
      try { Object.keys(localStorage).filter(k => k.startsWith('notified-')).forEach(k => localStorage.removeItem(k)); } catch { /* sem storage */ }
      state.invoiceMonth = {};
      toast('Tudo zerado. Pode começar do zero!');
      refresh();
    },
  });
  $$('[data-acc]').forEach(el => el.onclick = () => accountForm(state.accounts.find(a => a.id === +el.dataset.acc)));
  $('#cat-new').onclick = () => categoryForm();
  $$('[data-cat]').forEach(el => el.onclick = () => categoryForm(catById(+el.dataset.cat)));

  $('#rem-form').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      state.settings = await api.put('/settings', { reminder_days_default: +fd.get('reminder_days_default'), notify_hour: +fd.get('notify_hour') });
      toast('Lembretes salvos');
      refreshReminders();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#ntfy-form').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      state.settings = await api.put('/settings', { ntfy_server: fd.get('ntfy_server').trim(), ntfy_topic: fd.get('ntfy_topic').trim(), ntfy_enabled: fd.get('ntfy_enabled') === 'on' });
      toast('Configuração salva');
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#ntfy-test').onclick = async () => {
    try {
      const fd = new FormData($('#ntfy-form'));
      state.settings = await api.put('/settings', { ntfy_server: fd.get('ntfy_server').trim(), ntfy_topic: fd.get('ntfy_topic').trim() });
      const r = await api.post('/notifications/test');
      toast(`Enviado (${r.sent} lembrete(s))`);
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#notif-toggle')?.addEventListener('click', async () => {
    if (notifOn) { store('browserNotify', false); return Settings(); }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Permissão negada pelo navegador', 'error');
    store('browserNotify', true);
    toast('Notificações ativadas');
    Settings();
    refreshReminders();
  });
  $('#notif-test')?.addEventListener('click', () => new Notification('Minhas Finanças', { body: 'As notificações estão funcionando ✓', icon: 'icon.svg' }));
}

function restoreDialog(file) {
  const size = file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`;
  openModal({
    title: 'Importar backup',
    submitLabel: 'Substituir meus dados',
    body: `<p>Arquivo: <b>${esc(file.name)}</b> <span class="muted">(${size})</span></p>
      <p>Todos os dados atuais (lançamentos, contas fixas, cartões, contas, categorias e configurações) serão
        <b>substituídos</b> pelos do arquivo.</p>
      <p class="muted small">Por segurança, uma cópia dos dados atuais é salva automaticamente em
        <code>backend/data/backups/</code> antes da importação.</p>`,
    onOpen(form) { $('[type=submit]', form).classList.replace('primary', 'danger'); },
    async onSubmit() {
      const res = await apiFetch('/restore', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Erro ${res.status}`);
      state.invoiceMonth = {};
      const n = data.counts?.transactions ?? 0;
      toast(`Backup importado: ${n} lançamento(s)`);
      refresh();
    },
  });
}

// ======================================================================= lembretes (sino)

let reminders = [];
async function refreshReminders() {
  try { reminders = await api.get('/reminders'); } catch { return; }
  const badge = $('#bell-count');
  badge.hidden = !reminders.length;
  badge.textContent = reminders.length;
  badge.style.background = reminders.some(r => r.status !== 'upcoming') ? 'var(--danger)' : 'var(--warn)';
  renderRemindersPopover();
  browserNotify();
}

function renderRemindersPopover() {
  $('#reminders').innerHTML = `<div class="panel-head" style="padding-top:8px"><h2>Lembretes</h2><a href="#/config" class="small">Configurar</a></div>
    <div class="list">${reminders.map((r, i) => `<div class="row">
      <div class="main-col"><div class="title">${esc(r.description)}</div>
        <div class="meta">${r.type === 'invoice' ? '💳 ' : ''}<span class="tag ${r.status === 'upcoming' ? 'warn' : 'danger'}">${dueLabel(r.days_until)}</span> ${fmtDate(r.due_date)}</div></div>
      <div class="amount num">${fmtMoney(r.amount)}</div>
      <button class="btn sm" data-rem="${i}">Pagar</button></div>`).join('') || '<div class="empty">Nenhuma conta vencendo 🎉</div>'}</div>`;
  $$('[data-rem]', $('#reminders')).forEach(b => b.onclick = async () => {
    const r = reminders[+b.dataset.rem];
    $('#reminders').hidden = true;
    if (r.type === 'invoice') {
      invoicePayDialog({ card_id: r.card_id, month: r.month, total: r.amount, due_date: r.due_date, card_name: r.description.replace(/^Fatura /, '') });
    } else {
      payDialog(await api.get(`/transactions/${r.id}`));
    }
  });
}

function browserNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !storage('browserNotify', false)) return;
  const key = `notified-${todayISO()}`;
  const done = new Set(storage(key, []));
  const fresh = reminders.filter(r => !done.has(String(r.id)));
  if (!fresh.length) return;
  new Notification(fresh.length === 1 ? `${fresh[0].description} — ${dueLabel(fresh[0].days_until)}` : `${fresh.length} contas para pagar`, {
    body: fresh.map(r => `${r.description}: ${fmtMoney(r.amount)} (${dueLabel(r.days_until)})`).join('\n'),
    icon: 'icon.svg',
    tag: key,
  });
  store(key, [...done, ...fresh.map(r => String(r.id))]);
}

document.addEventListener('click', e => {
  if (!e.target.closest('[data-backup]')) return;
  e.preventDefault();
  downloadBackup().catch(err => toast(err.message, 'error'));
});

$('#bell').onclick = e => {
  e.stopPropagation();
  $('#reminders').hidden = !$('#reminders').hidden;
};
document.addEventListener('click', e => {
  if (!e.target.closest('#reminders') && !e.target.closest('#bell')) $('#reminders').hidden = true;
});

// ======================================================================= router

const routes = { dashboard: Dashboard, lancamentos: Transactions, fixas: Recurrences, cartoes: Cards, config: Settings };

async function render() {
  const [name, ...params] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const route = routes[name] ? name : 'dashboard';
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  try {
    await routes[route](...params);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty error">Erro ao carregar: ${esc(e.message)}</div>`;
  }
}

$('#fab').onclick = () => {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  transactionForm(null, name === 'cartoes' && id ? { card_id: +id } : {});
};
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
document.addEventListener('keydown', e => {
  if (e.key === 'n' && !$('#modal').open && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $('#fab').click();
  }
});

(async function init() {
  try {
    await loadRefs();
  } catch (e) {
    view.innerHTML = `<div class="empty error">Não foi possível falar com o servidor: ${esc(e.message)}</div>`;
    return;
  }
  await render();
  refreshReminders();
  setInterval(refreshReminders, 15 * 60 * 1000);
})();
