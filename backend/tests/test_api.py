import os
from datetime import date

import pytest

os.environ["FINANCAS_DISABLE_NOTIFIER"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from app import db, logic, main  # noqa: E402

TODAY = date(2026, 10, 5)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(main, "today", lambda: TODAY)
    with TestClient(main.app) as c:
        yield c


# ------------------------------------------------------------------ regras puras


@pytest.mark.parametrize(
    "purchase, closing, due, expected",
    [
        (date(2026, 10, 3), 5, 15, "2026-10"),   # antes do fechamento, vence no mesmo mês
        (date(2026, 10, 5), 5, 15, "2026-11"),   # no dia do fechamento -> próxima
        (date(2026, 10, 20), 28, 5, "2026-11"),  # fecha 28, vence dia 5 do mês seguinte
        (date(2026, 10, 29), 28, 5, "2026-12"),
        (date(2026, 12, 30), 28, 5, "2027-02"),  # virada de ano
        (date(2026, 2, 27), 31, 10, "2026-03"),  # fechamento 31 em fevereiro -> dia 28
        (date(2026, 2, 28), 31, 10, "2026-04"),
    ],
)
def test_invoice_month_for(purchase, closing, due, expected):
    assert logic.invoice_month_for(purchase, closing, due) == expected


def test_occurrences():
    start = date(2026, 1, 31)
    assert logic.occurrences("monthly", None, start, None, "2026-02") == [date(2026, 2, 28)]
    assert logic.occurrences("monthly", 10, date(2026, 10, 15), None, "2026-10") == []
    assert logic.occurrences("yearly", 15, date(2025, 3, 1), None, "2026-03") == [date(2026, 3, 15)]
    assert logic.occurrences("yearly", 15, date(2025, 3, 1), None, "2026-04") == []
    weekly = logic.occurrences("weekly", None, date(2026, 10, 2), None, "2026-10")
    assert weekly == [date(2026, 10, d) for d in (2, 9, 16, 23, 30)]
    assert logic.occurrences("monthly", 5, date(2026, 1, 1), date(2026, 3, 1), "2026-04") == []


# ------------------------------------------------------------------ API


def test_seed(client):
    assert len(client.get("/api/accounts").json()) == 1
    assert any(c["kind"] == "income" for c in client.get("/api/categories").json())


def test_expense_and_balance(client):
    acc = client.get("/api/accounts").json()[0]
    client.post("/api/transactions", json={
        "kind": "income", "description": "Salário", "amount": 500000,
        "date": "2026-10-01", "account_id": acc["id"], "paid": True})
    tx = client.post("/api/transactions", json={
        "kind": "expense", "description": "Mercado", "amount": 25050,
        "date": "2026-10-04", "account_id": acc["id"], "paid": True}).json()[0]
    assert tx["paid"] is True and tx["paid_date"] == "2026-10-04"
    assert client.get("/api/accounts").json()[0]["balance"] == 500000 - 25050

    s = client.get("/api/summary?month=2026-10").json()
    assert s["income"]["received"] == 500000
    assert s["expense"]["paid"] == 25050
    assert s["balance_forecast"] == 500000 - 25050


def test_card_installments_and_invoice(client):
    acc = client.get("/api/accounts").json()[0]
    card = client.post("/api/cards", json={
        "name": "Nubank", "credit_limit": 500000, "closing_day": 28, "due_day": 5,
        "account_id": acc["id"]}).json()
    txs = client.post("/api/transactions", json={
        "kind": "expense", "description": "TV", "amount": 100000, "date": "2026-10-10",
        "card_id": card["id"], "installments": 3}).json()
    assert [t["invoice_month"] for t in txs] == ["2026-11", "2026-12", "2027-01"]
    assert [t["amount"] for t in txs] == [33334, 33333, 33333]
    assert [t["installment_no"] for t in txs] == [1, 2, 3]

    cards = client.get("/api/cards").json()
    assert cards[0]["used_limit"] == 100000
    assert cards[0]["current_invoice"]["month"] == "2026-11"

    inv = client.get(f"/api/cards/{card['id']}/invoice?month=2026-11").json()
    assert inv["total"] == 33334 and inv["status"] == "aberta"
    assert inv["closing_date"] == "2026-10-28" and inv["due_date"] == "2026-11-05"

    paid = client.post(f"/api/cards/{card['id']}/invoice/2026-11/pay", json={}).json()
    assert paid["paid"] and paid["paid_amount"] == 33334
    assert client.get("/api/accounts").json()[0]["balance"] == -33334
    assert client.get("/api/cards").json()[0]["used_limit"] == 66666
    listed = client.get("/api/transactions?month=2026-10").json()
    assert listed[0]["paid"] is True  # pago via fatura

    s = client.get("/api/summary?month=2026-11").json()
    assert s["expense"]["total"] == 33334 and s["expense"]["paid"] == 33334

    # excluir parcelas futuras
    r = client.delete(f"/api/transactions/{txs[1]['id']}?scope=future").json()
    assert r["deleted"] == 2


def test_recurrence_generation_skip_and_reminders(client):
    acc = client.get("/api/accounts").json()[0]
    rec = client.post("/api/recurrences", json={
        "description": "Internet", "amount": 9990, "day": 7, "start_date": "2026-10-01",
        "account_id": acc["id"], "bill_type": "boleto", "reminder_days": 3}).json()
    assert rec["next_date"] == "2026-10-07"
    assert rec["current"]["date"] == "2026-10-07"

    reminders = client.get("/api/reminders").json()
    assert [(r["description"], r["days_until"]) for r in reminders] == [("Internet", 2)]

    oct_tx = client.get("/api/transactions?month=2026-10").json()
    assert len(oct_tx) == 1
    # pagar com valor diferente
    paid = client.post(f"/api/transactions/{oct_tx[0]['id']}/pay", json={"amount": 10500}).json()
    assert paid["paid"] and paid["amount"] == 10500
    assert client.get("/api/reminders").json() == []

    # excluir uma ocorrência não deve recriá-la
    nov = client.get("/api/transactions?month=2026-11").json()
    client.delete(f"/api/transactions/{nov[0]['id']}")
    assert client.get("/api/transactions?month=2026-11").json() == []
    assert len(client.get("/api/transactions?month=2026-12").json()) == 1

    # editar a recorrência atualiza ocorrências futuras não pagas
    client.put(f"/api/recurrences/{rec['id']}", json={**{k: rec[k] for k in (
        "description", "bill_type", "day", "start_date", "account_id", "reminder_days")}, "amount": 12000})
    dec = client.get("/api/transactions?month=2026-12").json()
    assert dec[0]["amount"] == 12000
    assert client.get("/api/transactions?month=2026-10").json()[0]["amount"] == 10500


def test_settings(client):
    s = client.put("/api/settings", json={"reminder_days_default": 5, "ntfy_topic": "abc"}).json()
    assert s["reminder_days_default"] == 5 and s["ntfy_topic"] == "abc" and s["ntfy_enabled"] is False


def test_daily_grid(client):
    acc = client.get("/api/accounts").json()[0]
    client.put(f"/api/accounts/{acc['id']}", json={"name": "Conta", "initial_balance": 100000})
    card = client.post("/api/cards", json={"name": "C", "closing_day": 28, "due_day": 6}).json()
    post = lambda **kw: client.post("/api/transactions", json={"description": "x", "account_id": acc["id"], **kw})
    post(kind="income", amount=50000, date="2026-10-06")
    post(kind="expense", amount=20000, date="2026-10-10")                      # saída (padrão)
    post(kind="expense", amount=3000, date="2026-10-10", nature="daily")       # diário
    post(kind="expense", amount=10000, date="2026-10-15", nature="saving")     # economia
    post(kind="income", amount=4000, date="2026-10-20", nature="saving")       # resgate
    post(kind="income", amount=999, date="2026-10-21", nature="daily")         # receita não aceita "daily"
    post(kind="expense", amount=7000, date="2026-09-20", card_id=card["id"])   # fatura vence 06/10
    post(kind="expense", amount=500, date="2026-09-30")                        # antes do período

    g = client.get("/api/daily?start=2026-10&months=2").json()
    assert g["opening_balance"] == 100000 - 500
    oct_ = g["months"][0]
    day = {d["date"][8:]: d for d in oct_["days"]}
    assert day["06"]["income"] == 50000 and day["06"]["card"] == 7000
    assert day["06"]["balance"] == 99500 + 50000 - 7000
    assert day["10"]["bills"] == 20000 and day["10"]["daily"] == 3000
    assert day["15"]["savings"] == 10000 and day["20"]["savings"] == -4000
    assert day["21"]["income"] == 999
    assert oct_["totals"]["savings"] == 6000
    assert oct_["end_balance"] == 99500 + 50000 + 999 - 7000 - 20000 - 3000 - 6000
    assert len(oct_["days"]) == 31 and g["months"][1]["days"][0]["balance"] == oct_["end_balance"]


def test_business_days():
    assert logic.easter(2027) == date(2027, 3, 28)
    nb = logic.next_business_day
    assert nb(date(2026, 10, 10)) == date(2026, 10, 13)   # sáb -> (seg 12/10 feriado) -> ter
    assert nb(date(2027, 2, 8)) == date(2027, 2, 10)      # carnaval
    assert nb(date(2026, 12, 25)) == date(2026, 12, 28)   # natal (sex) -> seg
    assert nb(date(2026, 10, 14)) == date(2026, 10, 14)
    # vencimento de fatura também é ajustado
    assert logic.invoice_due_date("2026-10", 10) == date(2026, 10, 13)


def test_recurrence_due_on_business_day(client):
    rec = client.post("/api/recurrences", json={
        "description": "Aluguel", "amount": 100000, "day": 10, "start_date": "2026-10-01"}).json()
    salary = client.post("/api/recurrences", json={
        "description": "Salário", "kind": "income", "amount": 100000, "day": 10, "start_date": "2026-10-01"}).json()
    txs = {t["description"]: t for t in client.get("/api/transactions?month=2026-10").json()}
    assert txs["Aluguel"]["date"] == "2026-10-13"
    assert txs["Salário"]["date"] == "2026-10-10"   # receitas não são deslocadas
    # pagar e excluir continuam funcionando com a data deslocada
    client.delete(f"/api/transactions/{txs['Aluguel']['id']}")
    assert "Aluguel" not in {t["description"] for t in client.get("/api/transactions?month=2026-10").json()}
    assert rec["id"] and salary["id"]


def test_installment_amount_mode(client):
    card = client.post("/api/cards", json={"name": "C", "closing_day": 1, "due_day": 10}).json()
    txs = client.post("/api/transactions", json={
        "kind": "expense", "description": "Geladeira", "amount": 25000, "date": "2026-10-05",
        "card_id": card["id"], "installments": 4, "amount_mode": "installment"}).json()
    assert [t["amount"] for t in txs] == [25000] * 4


def test_reset_and_backup(client):
    client.post("/api/cards", json={"name": "C", "closing_day": 1, "due_day": 10})
    client.post("/api/transactions", json={"kind": "expense", "description": "x", "amount": 1, "date": "2026-10-05"})
    client.put("/api/settings", json={"reminder_days_default": 7})
    assert client.post("/api/reset", json={"confirm": "sim"}).status_code == 400
    assert client.post("/api/reset", json={"confirm": "APAGAR"}).json() == {"ok": True}
    assert client.get("/api/cards").json() == []
    assert client.get("/api/transactions?month=2026-10").json() == []
    assert len(client.get("/api/accounts").json()) == 1
    assert len(client.get("/api/categories").json()) == len(db.DEFAULT_CATEGORIES)
    assert client.get("/api/settings").json()["reminder_days_default"] == 7
    r = client.get("/api/backup")
    assert r.status_code == 200 and r.content.startswith(b"SQLite format 3")


def test_restore_backup(client):
    card = client.post("/api/cards", json={"name": "Nubank", "closing_day": 1, "due_day": 10}).json()
    client.post("/api/transactions", json={"kind": "expense", "description": "TV", "amount": 30000,
                                           "date": "2026-10-05", "card_id": card["id"], "installments": 3})
    client.put("/api/settings", json={"ntfy_topic": "meu-topico"})
    backup = client.get("/api/backup").content

    client.post("/api/reset", json={"confirm": "APAGAR"})
    client.put("/api/settings", json={"ntfy_topic": "outro"})
    assert client.get("/api/cards").json() == []

    r = client.post("/api/restore", content=backup, headers={"Content-Type": "application/octet-stream"}).json()
    assert r["ok"] and r["counts"]["transactions"] == 3
    assert (db.DB_PATH.parent / "backups" / r["safety_backup"]).exists()
    assert [c["name"] for c in client.get("/api/cards").json()] == ["Nubank"]
    assert client.get("/api/settings").json()["ntfy_topic"] == "meu-topico"
    assert len(client.get("/api/transactions?month=2026-12").json()) == 1


def test_restore_rejects_invalid(client, tmp_path):
    assert client.post("/api/restore", content=b"nao sou um banco").status_code == 400
    import sqlite3
    other = tmp_path / "other.db"
    c = sqlite3.connect(other)
    c.execute("CREATE TABLE foo (x)")
    c.commit()
    c.close()
    r = client.post("/api/restore", content=other.read_bytes())
    assert r.status_code == 400 and "backup deste app" in r.json()["detail"]
    assert len(client.get("/api/accounts").json()) == 1  # nada foi alterado


def test_token_auth(client, monkeypatch):
    monkeypatch.setenv("FINANCAS_TOKEN", "segredo")
    assert client.get("/api/accounts").status_code == 401
    assert client.get("/api/accounts", headers={"Authorization": "Bearer errado"}).status_code == 401
    assert client.get("/api/accounts", headers={"Authorization": "Bearer segredo"}).status_code == 200
    assert client.get("/").status_code == 200  # interface web continua pública


def test_upcoming(client):
    client.post("/api/recurrences", json={
        "description": "Aluguel", "amount": 100000, "day": 20, "start_date": "2026-10-01", "reminder_days": 5})
    # fora da janela de lembrete (vence em 15 dias), mas dentro do horizonte de 60 dias
    assert client.get("/api/reminders").json() == []
    up = client.get("/api/upcoming?days=60").json()
    assert [(u["due_date"], u["remind_on"], u["remind_days"]) for u in up] == [
        ("2026-10-20", "2026-10-15", 5), ("2026-11-23", "2026-11-18", 5)]  # 20/11 é feriado
