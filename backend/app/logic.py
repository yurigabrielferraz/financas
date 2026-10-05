"""Regras de negócio: datas, faturas de cartão, recorrências, resumo e lembretes."""
import calendar
import sqlite3
from datetime import date, timedelta

from . import db

# ---------------------------------------------------------------- datas / meses


def ym(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def parse_ym(month: str) -> tuple[int, int]:
    try:
        y, m = (int(p) for p in month.split("-"))
    except ValueError:
        raise ValueError(f"Mês inválido: {month!r} (use AAAA-MM)")
    if not 1 <= m <= 12:
        raise ValueError(f"Mês inválido: {month!r}")
    return y, m


def shift_ym(month: str, n: int) -> str:
    y, m = parse_ym(month)
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def clamp_date(y: int, m: int, day: int) -> date:
    """Dia `day` do mês; se o mês for mais curto, usa o último dia (ex.: 31 -> 28/fev)."""
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def add_months(d: date, n: int) -> date:
    y, m = parse_ym(shift_ym(ym(d), n))
    return clamp_date(y, m, d.day)


def month_bounds(month: str) -> tuple[date, date]:
    y, m = parse_ym(month)
    return date(y, m, 1), clamp_date(y, m, 31)


# ---------------------------------------------------------------- dias úteis

FIXED_HOLIDAYS = {(1, 1), (4, 21), (5, 1), (9, 7), (10, 12), (11, 2), (11, 15), (11, 20), (12, 25)}


def easter(year: int) -> date:
    """Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = (h + l - 7 * m + 114) % 31 + 1
    return date(year, month, day)


_holiday_cache: dict[int, set[date]] = {}


def holidays(year: int) -> set[date]:
    """Feriados nacionais + dias sem expediente bancário (Carnaval, Sexta-feira Santa, Corpus Christi)."""
    if year not in _holiday_cache:
        e = easter(year)
        moving = {e - timedelta(days=48), e - timedelta(days=47), e - timedelta(days=2), e + timedelta(days=60)}
        _holiday_cache[year] = {date(year, m, d) for m, d in FIXED_HOLIDAYS} | moving
    return _holiday_cache[year]


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in holidays(d.year)


def next_business_day(d: date) -> date:
    while not is_business_day(d):
        d += timedelta(days=1)
    return d


# ---------------------------------------------------------------- cartões


def invoice_month_for(purchase: date, closing_day: int, due_day: int) -> str:
    """Mês (AAAA-MM) em que vence a fatura que contém uma compra feita em `purchase`.

    Compras feitas no dia do fechamento ou depois entram na fatura seguinte.
    Se o vencimento é antes/no dia do fechamento (ex.: fecha 28, vence 5),
    a fatura fechada em um mês vence no mês seguinte.
    """
    closing = clamp_date(purchase.year, purchase.month, closing_day)
    closing_month = ym(purchase) if purchase < closing else shift_ym(ym(purchase), 1)
    return closing_month if due_day > closing_day else shift_ym(closing_month, 1)


def invoice_closing_date(month: str, closing_day: int, due_day: int) -> date:
    closing_month = month if due_day > closing_day else shift_ym(month, -1)
    y, m = parse_ym(closing_month)
    return clamp_date(y, m, closing_day)


def invoice_due_date(month: str, due_day: int) -> date:
    y, m = parse_ym(month)
    return next_business_day(clamp_date(y, m, due_day))


def invoice_status(today: date, closing: date, due: date, paid: bool) -> str:
    if paid:
        return "paga"
    if today > due:
        return "vencida"
    if today >= closing:
        return "fechada"
    return "aberta"


def invoice_totals(conn: sqlite3.Connection, month: str) -> dict[int, int]:
    rows = conn.execute(
        """SELECT card_id, SUM(CASE WHEN kind = 'expense' THEN amount ELSE -amount END) AS total
           FROM transactions WHERE card_id IS NOT NULL AND invoice_month = ?
           GROUP BY card_id""",
        (month,),
    )
    return {r["card_id"]: r["total"] for r in rows}


def invoice_payment(conn: sqlite3.Connection, card_id: int, month: str):
    return conn.execute(
        "SELECT * FROM invoice_payments WHERE card_id = ? AND month = ?", (card_id, month)
    ).fetchone()


def card_invoice_summary(conn: sqlite3.Connection, card: sqlite3.Row, month: str, today: date) -> dict:
    total = invoice_totals(conn, month).get(card["id"], 0)
    payment = invoice_payment(conn, card["id"], month)
    closing = invoice_closing_date(month, card["closing_day"], card["due_day"])
    due = invoice_due_date(month, card["due_day"])
    return {
        "card_id": card["id"],
        "card_name": card["name"],
        "color": card["color"],
        "month": month,
        "total": total,
        "closing_date": closing.isoformat(),
        "due_date": due.isoformat(),
        "paid": payment is not None,
        "paid_amount": payment["amount"] if payment else None,
        "paid_date": payment["paid_date"] if payment else None,
        "status": invoice_status(today, closing, due, payment is not None),
    }


def card_used_limit(conn: sqlite3.Connection, card_id: int) -> int:
    """Limite comprometido: tudo que está em faturas ainda não pagas (inclui parcelas futuras)."""
    row = conn.execute(
        """SELECT COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount ELSE -t.amount END), 0)
           FROM transactions t
           WHERE t.card_id = ? AND NOT EXISTS (
               SELECT 1 FROM invoice_payments ip
               WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)""",
        (card_id,),
    ).fetchone()
    return row[0]


# ---------------------------------------------------------------- recorrências


def occurrences(frequency: str, day: int | None, start: date, end: date | None, month: str) -> list[date]:
    y, m = parse_ym(month)
    first, last = month_bounds(month)
    target_day = day or start.day
    if frequency == "monthly":
        dates = [clamp_date(y, m, target_day)]
    elif frequency == "yearly":
        dates = [clamp_date(y, m, target_day)] if m == start.month else []
    else:  # weekly: mesmo dia da semana da data de início
        offset = (first - start).days % 7
        d = first + timedelta(days=(7 - offset) % 7)
        dates = []
        while d <= last:
            dates.append(d)
            d += timedelta(days=7)
    return [d for d in dates if d >= start and (end is None or d <= end)]


def ensure_month(conn: sqlite3.Connection, month: str) -> None:
    """Cria (se ainda não existirem) os lançamentos das recorrências ativas no mês."""
    cards = {c["id"]: c for c in conn.execute("SELECT * FROM cards")}
    skips = {(r[0], r[1]) for r in conn.execute("SELECT recurrence_id, date FROM recurrence_skips")}
    for rec in conn.execute("SELECT * FROM recurrences WHERE active = 1").fetchall():
        start = date.fromisoformat(rec["start_date"])
        end = date.fromisoformat(rec["end_date"]) if rec["end_date"] else None
        for d in occurrences(rec["frequency"], rec["day"], start, end, month):
            if (rec["id"], d.isoformat()) in skips:
                continue
            card = cards.get(rec["card_id"])
            # vencimentos de contas (sem cartão) que caem em fim de semana/feriado vão para o próximo dia útil
            due = next_business_day(d) if rec["kind"] == "expense" and not card else d
            conn.execute(
                """INSERT OR IGNORE INTO transactions
                   (kind, description, amount, date, category_id, account_id, card_id,
                    invoice_month, recurrence_id, recurrence_date, nature)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    rec["kind"], rec["description"], rec["amount"], due.isoformat(),
                    rec["category_id"], None if card else rec["account_id"],
                    card["id"] if card else None,
                    invoice_month_for(d, card["closing_day"], card["due_day"]) if card else None,
                    rec["id"], d.isoformat(), rec["nature"],
                ),
            )


def clear_future_occurrences(conn: sqlite3.Connection, recurrence_id: int, today: date) -> None:
    """Remove ocorrências futuras não pagas (para serem regeradas após editar a recorrência)."""
    conn.execute(
        """DELETE FROM transactions
           WHERE recurrence_id = ? AND recurrence_date >= ? AND paid = 0
             AND (card_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM invoice_payments ip
                 WHERE ip.card_id = transactions.card_id AND ip.month = transactions.invoice_month))""",
        (recurrence_id, today.isoformat()),
    )


# ---------------------------------------------------------------- saldos / resumo


def account_balances(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """SELECT a.*, a.initial_balance
             + COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END)
                         FROM transactions t
                         WHERE t.account_id = a.id AND t.card_id IS NULL AND t.paid = 1), 0)
             - COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.account_id = a.id), 0)
             AS balance
           FROM accounts a ORDER BY a.archived, a.name"""
    )
    return [dict(r) for r in rows]


def summary(conn: sqlite3.Connection, month: str, today: date) -> dict:
    ensure_month(conn, shift_ym(month, -1))
    ensure_month(conn, month)
    first, last = month_bounds(month)
    rng = (first.isoformat(), last.isoformat())

    totals = {("income", 0): 0, ("income", 1): 0, ("expense", 0): 0, ("expense", 1): 0}
    for r in conn.execute(
        """SELECT kind, paid, SUM(amount) AS total FROM transactions
           WHERE card_id IS NULL AND date BETWEEN ? AND ? GROUP BY kind, paid""",
        rng,
    ):
        totals[(r["kind"], r["paid"])] = r["total"]

    invoices = []
    for card in conn.execute("SELECT * FROM cards ORDER BY name").fetchall():
        inv = card_invoice_summary(conn, card, month, today)
        if inv["total"] or inv["paid"]:
            invoices.append(inv)

    inv_total = sum(i["total"] for i in invoices)
    inv_paid = sum(i["paid_amount"] for i in invoices if i["paid"])
    income_total = totals[("income", 0)] + totals[("income", 1)]
    income_received = totals[("income", 1)]
    expense_total = totals[("expense", 0)] + totals[("expense", 1)] + inv_total
    expense_paid = totals[("expense", 1)] + inv_paid

    by_category = [
        dict(r)
        for r in conn.execute(
            """SELECT c.id, COALESCE(c.name, 'Sem categoria') AS name,
                      COALESCE(c.color, '#94a3b8') AS color, SUM(t.amount) AS total
               FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
               WHERE t.kind = 'expense' AND t.date BETWEEN ? AND ?
               GROUP BY c.id ORDER BY total DESC""",
            rng,
        )
    ]

    pending = [
        dict(r)
        for r in conn.execute(
            """SELECT t.*, c.name AS category_name, c.color AS category_color,
                      r.bill_type, a.name AS account_name
               FROM transactions t
               LEFT JOIN categories c ON c.id = t.category_id
               LEFT JOIN recurrences r ON r.id = t.recurrence_id
               LEFT JOIN accounts a ON a.id = t.account_id
               WHERE t.card_id IS NULL AND t.paid = 0 AND t.date BETWEEN ? AND ?
               ORDER BY t.date, t.description""",
            rng,
        )
    ]

    accounts = account_balances(conn)
    return {
        "month": month,
        "income": {"total": income_total, "received": income_received},
        "expense": {"total": expense_total, "paid": expense_paid},
        "balance_forecast": income_total - expense_total,
        "balance_realized": income_received - expense_paid,
        "accounts_balance": sum(a["balance"] for a in accounts if not a["archived"]),
        "by_category": by_category,
        "invoices": invoices,
        "pending": pending,
    }


# ---------------------------------------------------------------- lembretes


def compute_reminders(conn: sqlite3.Connection, today: date) -> list[dict]:
    settings = db.get_settings(conn)
    default_days = int(settings["reminder_days_default"])
    cur = ym(today)
    for m in (shift_ym(cur, -1), cur, shift_ym(cur, 1)):
        ensure_month(conn, m)

    items: list[dict] = []

    def status(days: int) -> str:
        return "overdue" if days < 0 else "today" if days == 0 else "upcoming"

    horizon = (today + timedelta(days=62)).isoformat()
    for r in conn.execute(
        """SELECT t.id, t.description, t.amount, t.date, t.reminder_days,
                  r.reminder_days AS rec_days, r.bill_type, c.name AS category_name
           FROM transactions t
           LEFT JOIN recurrences r ON r.id = t.recurrence_id
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE t.card_id IS NULL AND t.kind = 'expense' AND t.paid = 0 AND t.date <= ?""",
        (horizon,),
    ):
        due = date.fromisoformat(r["date"])
        days = (due - today).days
        window = next(v for v in (r["reminder_days"], r["rec_days"], default_days) if v is not None)
        if days <= window:
            items.append({
                "type": "transaction",
                "id": r["id"],
                "description": r["description"],
                "amount": r["amount"],
                "due_date": r["date"],
                "days_until": days,
                "status": status(days),
                "bill_type": r["bill_type"],
                "category_name": r["category_name"],
            })

    for card in conn.execute("SELECT * FROM cards WHERE archived = 0").fetchall():
        window = card["reminder_days"] if card["reminder_days"] is not None else default_days
        for m in (shift_ym(cur, -2), shift_ym(cur, -1), cur, shift_ym(cur, 1)):
            inv = card_invoice_summary(conn, card, m, today)
            if inv["paid"] or inv["total"] <= 0:
                continue
            days = (date.fromisoformat(inv["due_date"]) - today).days
            if days <= window:
                items.append({
                    "type": "invoice",
                    "id": f"{card['id']}:{m}",
                    "card_id": card["id"],
                    "month": m,
                    "description": f"Fatura {card['name']}",
                    "amount": inv["total"],
                    "due_date": inv["due_date"],
                    "days_until": days,
                    "status": status(days),
                })

    items.sort(key=lambda i: (i["due_date"], i["description"]))
    return items


# ---------------------------------------------------------------- grade de saldos diários

GRID_COLUMNS = ("income", "bills", "daily", "savings", "card")


def grid_column(kind: str, nature: str | None) -> tuple[str, int]:
    """Coluna da grade e sinal (+1 / -1) de um lançamento que não é de cartão."""
    if kind == "income":
        return ("savings", -1) if nature == "saving" else ("income", 1)
    return {"daily": ("daily", 1), "saving": ("savings", 1)}.get(nature, ("bills", 1))


def invoice_events(conn: sqlite3.Connection) -> list[tuple[date, int]]:
    """(data de vencimento, valor) de todas as faturas; usa o valor pago quando houver."""
    cards = {c["id"]: c for c in conn.execute("SELECT id, due_day FROM cards")}
    payments = {(p["card_id"], p["month"]): p["amount"] for p in conn.execute("SELECT * FROM invoice_payments")}
    events = []
    for r in conn.execute(
        """SELECT card_id, invoice_month, SUM(CASE WHEN kind = 'expense' THEN amount ELSE -amount END) AS total
           FROM transactions WHERE card_id IS NOT NULL GROUP BY card_id, invoice_month"""
    ):
        card = cards.get(r["card_id"])
        if card:
            amount = payments.get((r["card_id"], r["invoice_month"]), r["total"])
            events.append((invoice_due_date(r["invoice_month"], card["due_day"]), amount))
    return events


def daily_grid(conn: sqlite3.Connection, start: str, months: int) -> dict:
    """Saldo projetado dia a dia: considera todos os lançamentos na sua data (pagos ou não)
    e cada fatura de cartão no dia do vencimento."""
    month_list = [shift_ym(start, i) for i in range(months)]
    for m in [shift_ym(start, -1)] + month_list:
        ensure_month(conn, m)
    first = month_bounds(month_list[0])[0]
    last = month_bounds(month_list[-1])[1]

    opening = conn.execute("SELECT COALESCE(SUM(initial_balance), 0) FROM accounts").fetchone()[0]
    opening += conn.execute(
        """SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE -amount END), 0)
           FROM transactions WHERE card_id IS NULL AND date < ?""",
        (first.isoformat(),),
    ).fetchone()[0]

    buckets: dict[str, dict[str, int]] = {}

    def bucket(d: str) -> dict[str, int]:
        return buckets.setdefault(d, dict.fromkeys(GRID_COLUMNS, 0))

    for due, amount in invoice_events(conn):
        if due < first:
            opening -= amount
        elif due <= last:
            bucket(due.isoformat())["card"] += amount

    for r in conn.execute(
        "SELECT kind, nature, amount, date FROM transactions WHERE card_id IS NULL AND date BETWEEN ? AND ?",
        (first.isoformat(), last.isoformat()),
    ):
        col, sign = grid_column(r["kind"], r["nature"])
        bucket(r["date"])[col] += sign * r["amount"]

    balance = opening
    result = []
    for m in month_list:
        d, end = month_bounds(m)
        days, totals = [], dict.fromkeys(GRID_COLUMNS, 0)
        while d <= end:
            b = buckets.get(d.isoformat()) or dict.fromkeys(GRID_COLUMNS, 0)
            balance += b["income"] - b["bills"] - b["daily"] - b["savings"] - b["card"]
            for k in GRID_COLUMNS:
                totals[k] += b[k]
            days.append({"date": d.isoformat(), **b, "balance": balance})
            d += timedelta(days=1)
        result.append({"month": m, "days": days, "totals": totals, "end_balance": balance})
    return {"start": start, "opening_balance": opening, "months": result}
