"""API REST de finanças pessoais.

Todos os valores monetários trafegam em CENTAVOS (inteiros). Datas em ISO (AAAA-MM-DD),
meses em AAAA-MM. Documentação interativa em /docs.
"""
import os
import sqlite3
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, logic, notifier

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    if os.environ.get("FINANCAS_DISABLE_NOTIFIER") != "1":
        notifier.start()
    yield


app = FastAPI(title="Finanças Pessoais API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
api = APIRouter(prefix="/api")


@app.middleware("http")
async def no_cache(request, call_next):
    # sempre revalida o front-end (evita JS/CSS antigo após atualizações)
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


def get_conn():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


Conn = Depends(get_conn)
BOOL_FIELDS = {"paid", "archived", "active"}
Kind = Literal["expense", "income"]
Nature = Optional[Literal["bill", "daily", "saving"]]


def norm_nature(kind: str, nature: Optional[str]) -> Optional[str]:
    # receitas só aceitam "saving" (resgate de economia)
    return nature if kind == "expense" or nature == "saving" else None


def today() -> date:
    return date.today()


def to_dict(row) -> dict:
    d = dict(row)
    for k in BOOL_FIELDS & d.keys():
        d[k] = bool(d[k])
    return d


def fetch(conn: sqlite3.Connection, table: str, id_: int) -> sqlite3.Row:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (id_,)).fetchone()
    if not row:
        raise HTTPException(404, f"{table}: id {id_} não encontrado")
    return row


def check_refs(conn: sqlite3.Connection, **refs: Optional[int]) -> None:
    tables = {"category_id": "categories", "account_id": "accounts", "card_id": "cards"}
    for field, value in refs.items():
        if value is not None:
            fetch(conn, tables[field], value)


def insert(conn: sqlite3.Connection, table: str, data: dict) -> int:
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)
    return conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", list(data.values())).lastrowid


def update(conn: sqlite3.Connection, table: str, id_: int, data: dict) -> None:
    sets = ", ".join(f"{k} = ?" for k in data)
    conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", [*data.values(), id_])


def valid_month(month: Optional[str]) -> str:
    if month is None:
        return logic.ym(today())
    try:
        logic.parse_ym(month)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return month


# ======================================================================= contas


class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    type: Literal["checking", "savings", "wallet", "investment", "other"] = "checking"
    initial_balance: int = 0
    color: str = "#4f46e5"
    archived: bool = False


@api.get("/accounts", tags=["contas"])
def list_accounts(conn=Conn):
    return [to_dict(a) for a in logic.account_balances(conn)]


@api.post("/accounts", status_code=201, tags=["contas"])
def create_account(body: AccountIn, conn=Conn):
    id_ = insert(conn, "accounts", body.model_dump(mode="json"))
    conn.commit()
    return to_dict(fetch(conn, "accounts", id_))


@api.put("/accounts/{id_}", tags=["contas"])
def update_account(id_: int, body: AccountIn, conn=Conn):
    fetch(conn, "accounts", id_)
    update(conn, "accounts", id_, body.model_dump(mode="json"))
    conn.commit()
    return to_dict(fetch(conn, "accounts", id_))


@api.delete("/accounts/{id_}", tags=["contas"])
def delete_account(id_: int, conn=Conn):
    """Exclui a conta; se ela já tiver movimentações, apenas arquiva."""
    fetch(conn, "accounts", id_)
    used = conn.execute(
        "SELECT 1 FROM transactions WHERE account_id = ? UNION SELECT 1 FROM invoice_payments WHERE account_id = ?",
        (id_, id_),
    ).fetchone()
    if used:
        conn.execute("UPDATE accounts SET archived = 1 WHERE id = ?", (id_,))
    else:
        conn.execute("DELETE FROM accounts WHERE id = ?", (id_,))
    conn.commit()
    return {"archived": bool(used), "deleted": not used}


# ======================================================================= categorias


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    kind: Kind
    color: str = "#64748b"
    icon: str = ""
    archived: bool = False


@api.get("/categories", tags=["categorias"])
def list_categories(kind: Optional[Kind] = None, conn=Conn):
    sql, args = "SELECT * FROM categories", []
    if kind:
        sql, args = sql + " WHERE kind = ?", [kind]
    return [to_dict(r) for r in conn.execute(sql + " ORDER BY kind, name", args)]


@api.post("/categories", status_code=201, tags=["categorias"])
def create_category(body: CategoryIn, conn=Conn):
    id_ = insert(conn, "categories", body.model_dump(mode="json"))
    conn.commit()
    return to_dict(fetch(conn, "categories", id_))


@api.put("/categories/{id_}", tags=["categorias"])
def update_category(id_: int, body: CategoryIn, conn=Conn):
    fetch(conn, "categories", id_)
    update(conn, "categories", id_, body.model_dump(mode="json"))
    conn.commit()
    return to_dict(fetch(conn, "categories", id_))


@api.delete("/categories/{id_}", status_code=204, tags=["categorias"])
def delete_category(id_: int, conn=Conn):
    fetch(conn, "categories", id_)
    conn.execute("DELETE FROM categories WHERE id = ?", (id_,))
    conn.commit()
    return Response(status_code=204)


# ======================================================================= cartões


class CardIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    credit_limit: int = Field(0, ge=0)
    closing_day: int = Field(ge=1, le=31)
    due_day: int = Field(ge=1, le=31)
    color: str = "#0ea5e9"
    account_id: Optional[int] = None
    reminder_days: Optional[int] = Field(None, ge=0, le=60)
    archived: bool = False


class InvoicePayIn(BaseModel):
    amount: Optional[int] = Field(None, ge=0, description="Padrão: total da fatura")
    paid_date: Optional[date] = None
    account_id: Optional[int] = Field(None, description="Padrão: conta vinculada ao cartão")


def card_out(conn, card, month: Optional[str], t: date) -> dict:
    current = month or logic.invoice_month_for(t, card["closing_day"], card["due_day"])
    d = to_dict(card)
    d["used_limit"] = logic.card_used_limit(conn, card["id"])
    d["available_limit"] = card["credit_limit"] - d["used_limit"]
    d["current_invoice"] = logic.card_invoice_summary(conn, card, current, t)
    return d


@api.get("/cards", tags=["cartões"])
def list_cards(month: Optional[str] = None, conn=Conn):
    """Lista cartões. Sem `month`, cada um traz a fatura atualmente aberta."""
    month = valid_month(month) if month else None
    t = today()
    cur = logic.ym(t)
    logic.ensure_month(conn, cur)
    logic.ensure_month(conn, logic.shift_ym(cur, 1))
    conn.commit()
    cards = conn.execute("SELECT * FROM cards ORDER BY archived, name").fetchall()
    return [card_out(conn, c, month, t) for c in cards]


@api.post("/cards", status_code=201, tags=["cartões"])
def create_card(body: CardIn, conn=Conn):
    check_refs(conn, account_id=body.account_id)
    id_ = insert(conn, "cards", body.model_dump(mode="json"))
    conn.commit()
    return card_out(conn, fetch(conn, "cards", id_), None, today())


@api.put("/cards/{id_}", tags=["cartões"])
def update_card(id_: int, body: CardIn, conn=Conn):
    old = fetch(conn, "cards", id_)
    check_refs(conn, account_id=body.account_id)
    update(conn, "cards", id_, body.model_dump(mode="json"))
    if (old["closing_day"], old["due_day"]) != (body.closing_day, body.due_day):
        # recalcula a fatura dos lançamentos em faturas ainda não pagas
        rows = conn.execute(
            """SELECT id, date FROM transactions t WHERE card_id = ? AND NOT EXISTS (
                 SELECT 1 FROM invoice_payments ip WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)""",
            (id_,),
        ).fetchall()
        for r in rows:
            inv = logic.invoice_month_for(date.fromisoformat(r["date"]), body.closing_day, body.due_day)
            conn.execute("UPDATE transactions SET invoice_month = ? WHERE id = ?", (inv, r["id"]))
    conn.commit()
    return card_out(conn, fetch(conn, "cards", id_), None, today())


@api.delete("/cards/{id_}", tags=["cartões"])
def delete_card(id_: int, conn=Conn):
    """Exclui o cartão; se já tiver lançamentos, apenas arquiva."""
    fetch(conn, "cards", id_)
    used = conn.execute("SELECT 1 FROM transactions WHERE card_id = ? LIMIT 1", (id_,)).fetchone()
    if used:
        conn.execute("UPDATE cards SET archived = 1 WHERE id = ?", (id_,))
    else:
        conn.execute("DELETE FROM cards WHERE id = ?", (id_,))
    conn.commit()
    return {"archived": bool(used), "deleted": not used}


@api.get("/cards/{id_}/invoice", tags=["cartões"])
def get_invoice(id_: int, month: Optional[str] = None, conn=Conn):
    card = fetch(conn, "cards", id_)
    t = today()
    month = valid_month(month) if month else logic.invoice_month_for(t, card["closing_day"], card["due_day"])
    for m in (logic.shift_ym(month, -2), logic.shift_ym(month, -1), month):
        logic.ensure_month(conn, m)
    conn.commit()
    inv = logic.card_invoice_summary(conn, card, month, t)
    inv["items"] = [
        to_dict(r)
        for r in conn.execute(
            """SELECT t.*, c.name AS category_name, c.color AS category_color
               FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
               WHERE t.card_id = ? AND t.invoice_month = ? ORDER BY t.date, t.id""",
            (id_, month),
        )
    ]
    return inv


@api.post("/cards/{id_}/invoice/{month}/pay", tags=["cartões"])
def pay_invoice(id_: int, month: str, body: InvoicePayIn, conn=Conn):
    card = fetch(conn, "cards", id_)
    month = valid_month(month)
    account_id = body.account_id if body.account_id is not None else card["account_id"]
    check_refs(conn, account_id=account_id)
    amount = body.amount if body.amount is not None else logic.invoice_totals(conn, month).get(id_, 0)
    conn.execute(
        """INSERT INTO invoice_payments (card_id, month, amount, paid_date, account_id) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(card_id, month) DO UPDATE SET
             amount = excluded.amount, paid_date = excluded.paid_date, account_id = excluded.account_id""",
        (id_, month, amount, (body.paid_date or today()).isoformat(), account_id),
    )
    conn.commit()
    return logic.card_invoice_summary(conn, card, month, today())


@api.delete("/cards/{id_}/invoice/{month}/pay", tags=["cartões"])
def unpay_invoice(id_: int, month: str, conn=Conn):
    card = fetch(conn, "cards", id_)
    conn.execute("DELETE FROM invoice_payments WHERE card_id = ? AND month = ?", (id_, valid_month(month)))
    conn.commit()
    return logic.card_invoice_summary(conn, card, month, today())


# ======================================================================= recorrências


class RecurrenceIn(BaseModel):
    description: str = Field(min_length=1, max_length=120)
    kind: Kind = "expense"
    bill_type: Literal["fixa", "boleto", "assinatura", "debito", "outro"] = "fixa"
    amount: int = Field(ge=0)
    category_id: Optional[int] = None
    account_id: Optional[int] = None
    card_id: Optional[int] = None
    frequency: Literal["weekly", "monthly", "yearly"] = "monthly"
    day: Optional[int] = Field(None, ge=1, le=31, description="Dia do vencimento (padrão: dia de start_date)")
    start_date: date
    end_date: Optional[date] = None
    reminder_days: Optional[int] = Field(None, ge=0, le=60)
    active: bool = True
    notes: Optional[str] = None
    nature: Nature = Field(None, description="bill = saída, daily = diário, saving = economia/resgate")

    def data(self) -> dict:
        d = self.model_dump(mode="json")
        d["nature"] = norm_nature(self.kind, self.nature)
        return d


def recurrence_out(conn, r, t: date) -> dict:
    d = to_dict(r)
    cur = logic.ym(t)
    occ = conn.execute(
        """SELECT id, date, amount, paid, card_id FROM transactions
           WHERE recurrence_id = ? AND substr(recurrence_date, 1, 7) = ? ORDER BY date LIMIT 1""",
        (r["id"], cur),
    ).fetchone()
    d["current"] = to_dict(occ) if occ else None
    nxt = None
    if r["active"]:
        start = date.fromisoformat(r["start_date"])
        end = date.fromisoformat(r["end_date"]) if r["end_date"] else None
        for i in range(0, 13):
            dates = [x for x in logic.occurrences(r["frequency"], r["day"], start, end, logic.shift_ym(cur, i)) if x >= t]
            if dates:
                nxt = dates[0].isoformat()
                break
    d["next_date"] = nxt
    return d


@api.get("/recurrences", tags=["contas fixas"])
def list_recurrences(conn=Conn):
    t = today()
    logic.ensure_month(conn, logic.ym(t))
    conn.commit()
    rows = conn.execute(
        """SELECT r.*, c.name AS category_name, c.color AS category_color,
                  a.name AS account_name, k.name AS card_name
           FROM recurrences r
           LEFT JOIN categories c ON c.id = r.category_id
           LEFT JOIN accounts a ON a.id = r.account_id
           LEFT JOIN cards k ON k.id = r.card_id
           ORDER BY r.active DESC, r.kind DESC, COALESCE(r.day, 99), r.description"""
    ).fetchall()
    return [recurrence_out(conn, r, t) for r in rows]


@api.post("/recurrences", status_code=201, tags=["contas fixas"])
def create_recurrence(body: RecurrenceIn, conn=Conn):
    check_refs(conn, category_id=body.category_id, account_id=body.account_id, card_id=body.card_id)
    id_ = insert(conn, "recurrences", body.data())
    logic.ensure_month(conn, logic.ym(today()))
    conn.commit()
    return recurrence_out(conn, fetch(conn, "recurrences", id_), today())


@api.put("/recurrences/{id_}", tags=["contas fixas"])
def update_recurrence(id_: int, body: RecurrenceIn, conn=Conn):
    """Atualiza a recorrência. Ocorrências futuras ainda não pagas são recriadas com os novos dados."""
    fetch(conn, "recurrences", id_)
    check_refs(conn, category_id=body.category_id, account_id=body.account_id, card_id=body.card_id)
    update(conn, "recurrences", id_, body.data())
    logic.clear_future_occurrences(conn, id_, today())
    logic.ensure_month(conn, logic.ym(today()))
    conn.commit()
    return recurrence_out(conn, fetch(conn, "recurrences", id_), today())


@api.delete("/recurrences/{id_}", status_code=204, tags=["contas fixas"])
def delete_recurrence(id_: int, conn=Conn):
    """Remove a recorrência e as ocorrências futuras não pagas; o histórico pago é mantido."""
    fetch(conn, "recurrences", id_)
    logic.clear_future_occurrences(conn, id_, today())
    conn.execute("DELETE FROM recurrences WHERE id = ?", (id_,))
    conn.commit()
    return Response(status_code=204)


# ======================================================================= lançamentos


class TransactionBase(BaseModel):
    kind: Kind
    description: str = Field(min_length=1, max_length=120)
    amount: int = Field(ge=0)
    date: date
    category_id: Optional[int] = None
    account_id: Optional[int] = None
    card_id: Optional[int] = None
    paid: bool = False
    paid_date: Optional[date] = None
    reminder_days: Optional[int] = Field(None, ge=0, le=60)
    notes: Optional[str] = None
    nature: Nature = Field(None, description="bill = saída, daily = diário, saving = economia/resgate")


class TransactionIn(TransactionBase):
    installments: int = Field(1, ge=1, le=72, description="Número de parcelas")
    amount_mode: Literal["total", "installment"] = Field(
        "total", description="`amount` é o valor total (dividido entre as parcelas) ou o valor de cada parcela")


class PayIn(BaseModel):
    paid: bool = True
    paid_date: Optional[date] = None
    account_id: Optional[int] = None
    amount: Optional[int] = Field(None, ge=0, description="Valor efetivamente pago (ex.: conta de luz)")


TX_COLUMNS = (
    "id, kind, description, amount, date, category_id, account_id, card_id, invoice_month, "
    "paid_date, recurrence_id, recurrence_date, installment_group, installment_no, "
    "installment_total, reminder_days, notes, nature, created_at, updated_at"
)
TX_SELECT = f"""
SELECT {", ".join("t." + c.strip() for c in TX_COLUMNS.split(","))},
       CASE WHEN t.card_id IS NOT NULL THEN EXISTS (
           SELECT 1 FROM invoice_payments ip WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)
       ELSE t.paid END AS paid,
       c.name AS category_name, c.color AS category_color,
       a.name AS account_name, k.name AS card_name, k.color AS card_color, r.bill_type
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN accounts a ON a.id = t.account_id
LEFT JOIN cards k ON k.id = t.card_id
LEFT JOIN recurrences r ON r.id = t.recurrence_id
"""


def tx_out(conn, id_: int) -> dict:
    row = conn.execute(TX_SELECT + " WHERE t.id = ?", (id_,)).fetchone()
    if not row:
        raise HTTPException(404, f"transactions: id {id_} não encontrado")
    return to_dict(row)


def tx_fields(body: TransactionBase, conn) -> dict:
    """Normaliza campos: cartão define a fatura e ignora conta/pago."""
    check_refs(conn, category_id=body.category_id, account_id=body.account_id, card_id=body.card_id)
    data = body.model_dump(mode="json", exclude={"installments", "amount_mode"})
    data["nature"] = norm_nature(body.kind, body.nature)
    if body.card_id is not None:
        card = fetch(conn, "cards", body.card_id)
        data.update(
            account_id=None, paid=False, paid_date=None,
            invoice_month=logic.invoice_month_for(body.date, card["closing_day"], card["due_day"]),
        )
    else:
        data["invoice_month"] = None
        if body.paid and not body.paid_date:
            data["paid_date"] = min(body.date, today()).isoformat()
        if not body.paid:
            data["paid_date"] = None
    return data


@api.get("/transactions", tags=["lançamentos"])
def list_transactions(
    month: Optional[str] = None,
    kind: Optional[Kind] = None,
    status: Optional[Literal["paid", "pending"]] = None,
    category_id: Optional[int] = None,
    account_id: Optional[int] = None,
    card_id: Optional[int] = None,
    q: Optional[str] = Query(None, description="Busca na descrição"),
    conn=Conn,
):
    """Lançamentos do mês pela data (compra ou vencimento)."""
    month = valid_month(month)
    logic.ensure_month(conn, month)
    conn.commit()
    first, last = logic.month_bounds(month)
    where, args = ["t.date BETWEEN ? AND ?"], [first.isoformat(), last.isoformat()]
    for col, val in (("t.kind", kind), ("t.category_id", category_id), ("t.account_id", account_id), ("t.card_id", card_id)):
        if val is not None:
            where.append(f"{col} = ?")
            args.append(val)
    if q:
        where.append("t.description LIKE ?")
        args.append(f"%{q}%")
    sql = f"SELECT * FROM ({TX_SELECT} WHERE {' AND '.join(where)})"
    if status:
        sql += " WHERE paid = ?"
        args.append(1 if status == "paid" else 0)
    sql += " ORDER BY date DESC, id DESC"
    return [to_dict(r) for r in conn.execute(sql, args)]


@api.post("/transactions", status_code=201, tags=["lançamentos"])
def create_transaction(body: TransactionIn, conn=Conn):
    """Cria um lançamento. Com `installments` > 1 cria N parcelas mensais (no cartão, uma por fatura)."""
    base = tx_fields(body, conn)
    n = body.installments
    group = uuid.uuid4().hex if n > 1 else None
    if body.amount_mode == "installment":
        each, rest = body.amount, 0
    else:
        each, rest = divmod(body.amount, n)
    ids = []
    for i in range(n):
        data = dict(base)
        d = logic.add_months(body.date, i)
        data.update(date=d.isoformat(), amount=each + (rest if i == 0 else 0))
        if n > 1:
            data.update(installment_group=group, installment_no=i + 1, installment_total=n)
            if i > 0:
                data.update(paid=False, paid_date=None)
        if body.card_id is not None:
            data["invoice_month"] = logic.shift_ym(base["invoice_month"], i)
        ids.append(insert(conn, "transactions", data))
    conn.commit()
    return [tx_out(conn, i) for i in ids]


@api.get("/transactions/{id_}", tags=["lançamentos"])
def get_transaction(id_: int, conn=Conn):
    return tx_out(conn, id_)


@api.put("/transactions/{id_}", tags=["lançamentos"])
def update_transaction(id_: int, body: TransactionBase, conn=Conn):
    fetch(conn, "transactions", id_)
    data = tx_fields(body, conn)
    data["updated_at"] = datetime.now().isoformat(timespec="seconds")
    update(conn, "transactions", id_, data)
    conn.commit()
    return tx_out(conn, id_)


@api.post("/transactions/{id_}/pay", tags=["lançamentos"])
def pay_transaction(id_: int, body: PayIn, conn=Conn):
    """Marca (ou desmarca, com `paid: false`) um lançamento como pago/recebido."""
    tx = fetch(conn, "transactions", id_)
    if tx["card_id"] is not None:
        raise HTTPException(400, "Lançamentos de cartão são quitados pelo pagamento da fatura")
    check_refs(conn, account_id=body.account_id)
    data = {"paid": body.paid, "paid_date": (body.paid_date or today()).isoformat() if body.paid else None}
    if body.account_id is not None:
        data["account_id"] = body.account_id
    if body.amount is not None:
        data["amount"] = body.amount
    update(conn, "transactions", id_, data)
    conn.commit()
    return tx_out(conn, id_)


@api.delete("/transactions/{id_}", tags=["lançamentos"])
def delete_transaction(
    id_: int,
    scope: Literal["one", "future", "all"] = Query("one", description="Para parcelados: só esta, esta e as próximas, ou todas"),
    conn=Conn,
):
    tx = fetch(conn, "transactions", id_)
    if tx["installment_group"] and scope != "one":
        sql = "SELECT id, recurrence_id, recurrence_date FROM transactions WHERE installment_group = ?"
        args = [tx["installment_group"]]
        if scope == "future":
            sql += " AND installment_no >= ?"
            args.append(tx["installment_no"])
        rows = conn.execute(sql, args).fetchall()
    else:
        rows = [tx]
    for r in rows:
        if r["recurrence_id"] is not None:
            conn.execute(
                "INSERT OR IGNORE INTO recurrence_skips (recurrence_id, date) VALUES (?, ?)",
                (r["recurrence_id"], r["recurrence_date"]),
            )
        conn.execute("DELETE FROM transactions WHERE id = ?", (r["id"],))
    conn.commit()
    return {"deleted": len(rows)}


# ======================================================================= resumo / lembretes / config


@api.get("/summary", tags=["resumo"])
def get_summary(month: Optional[str] = None, conn=Conn):
    """Visão de caixa do mês: receitas, despesas (contas + faturas que vencem no mês), saldos."""
    result = logic.summary(conn, valid_month(month), today())
    conn.commit()
    result["pending"] = [to_dict(p) for p in result["pending"]]
    return result


@api.get("/daily", tags=["resumo"])
def get_daily(start: Optional[str] = None, months: int = Query(12, ge=1, le=24), conn=Conn):
    """Grade de saldos: por dia, entradas / saídas / diários / economias / cartão e saldo projetado."""
    result = logic.daily_grid(conn, valid_month(start), months)
    conn.commit()
    return result


@api.get("/reminders", tags=["lembretes"])
def get_reminders(conn=Conn):
    """Contas vencidas e a vencer dentro da janela de lembrete de cada uma."""
    items = logic.compute_reminders(conn, today())
    conn.commit()
    return items


class SettingsIn(BaseModel):
    reminder_days_default: Optional[int] = Field(None, ge=0, le=60)
    notify_hour: Optional[int] = Field(None, ge=0, le=23)
    ntfy_enabled: Optional[bool] = None
    ntfy_server: Optional[str] = None
    ntfy_topic: Optional[str] = None


@api.get("/settings", tags=["configurações"])
def get_settings(conn=Conn):
    return db.get_settings(conn)


@api.put("/settings", tags=["configurações"])
def put_settings(body: SettingsIn, conn=Conn):
    db.set_settings(conn, body.model_dump(exclude_none=True))
    conn.commit()
    return db.get_settings(conn)


class ResetIn(BaseModel):
    confirm: str = Field(description='Precisa ser exatamente "APAGAR"')


@api.post("/reset", tags=["configurações"])
def reset_all(body: ResetIn, conn=Conn):
    """Apaga TODOS os lançamentos, contas fixas, cartões, contas e categorias (recria os padrões).
    As configurações de lembretes são mantidas."""
    if body.confirm != "APAGAR":
        raise HTTPException(400, 'Para confirmar, envie {"confirm": "APAGAR"}')
    db.reset_data(conn)
    conn.commit()
    return {"ok": True}


@api.get("/backup", tags=["configurações"])
def backup(conn=Conn):
    """Baixa uma cópia do banco de dados SQLite."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    dst = sqlite3.connect(path)
    try:
        conn.backup(dst)
    finally:
        dst.close()
    return FileResponse(path, filename=f"financas-backup-{today().isoformat()}.db",
                        media_type="application/octet-stream", background=BackgroundTask(os.unlink, path))


MAX_BACKUP_BYTES = 200 * 1024 * 1024


@api.post("/restore", tags=["configurações"])
async def restore(request: Request):
    """Importa um backup (.db baixado em /api/backup), enviado como corpo binário da requisição.

    Substitui TODOS os dados e configurações atuais. Antes disso, uma cópia dos dados atuais
    é salva em `data/backups/`."""
    data = await request.body()
    if len(data) > MAX_BACKUP_BYTES:
        raise HTTPException(413, "Arquivo grande demais")
    if not data.startswith(b"SQLite format 3\x00"):
        raise HTTPException(400, "O arquivo não é um backup válido (esperado um arquivo .db)")
    fd, path = tempfile.mkstemp(suffix=".db")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        try:
            db.validate_backup(path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        conn = db.connect()
        try:
            safety = db.snapshot(conn, "antes-de-importar")
            counts = db.restore_from(conn, path)
        finally:
            conn.close()
    finally:
        os.unlink(path)
    return {"ok": True, "safety_backup": safety.name, "counts": counts}


@api.post("/notifications/test", tags=["configurações"])
def test_notification(conn=Conn):
    """Envia agora o resumo de lembretes para o tópico ntfy configurado."""
    if not db.get_settings(conn)["ntfy_topic"]:
        raise HTTPException(400, "Configure um tópico do ntfy primeiro")
    try:
        sent = notifier.check_and_send(force=True)
    except Exception as e:
        raise HTTPException(502, f"Falha ao enviar para o ntfy: {e}")
    return {"sent": sent}


app.include_router(api)


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(FRONTEND_DIR / "icon.svg", media_type="image/svg+xml")

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="web")
