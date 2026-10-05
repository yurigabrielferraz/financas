"""Envio de lembretes para o celular via ntfy (https://ntfy.sh) — opcional.

Uma thread em segundo plano verifica a cada 10 minutos; uma vez por dia, depois do
horário configurado, envia um resumo das contas vencidas / a vencer.
"""
import json
import logging
import threading
import time
import urllib.request
from datetime import datetime

from . import db, logic

log = logging.getLogger("financas.notifier")


def fmt_brl(cents: int) -> str:
    s = f"{cents / 100:,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")


def build_message(items: list[dict]) -> tuple[str, str]:
    overdue = [i for i in items if i["status"] == "overdue"]
    title = f"{len(items)} conta(s) para pagar" + (f" — {len(overdue)} vencida(s)" if overdue else "")
    lines = []
    for i in items:
        when = (
            f"venceu há {-i['days_until']}d" if i["days_until"] < 0
            else "vence hoje" if i["days_until"] == 0
            else f"vence em {i['days_until']}d"
        )
        lines.append(f"• {i['description']}: {fmt_brl(i['amount'])} ({when})")
    return title, "\n".join(lines)


def send_ntfy(server: str, topic: str, title: str, message: str, priority: int = 3) -> None:
    payload = json.dumps({
        "topic": topic, "title": title, "message": message,
        "priority": priority, "tags": ["moneybag"],
    }).encode()
    req = urllib.request.Request(
        server.rstrip("/"), data=payload, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10):
        pass


def check_and_send(now: datetime | None = None, force: bool = False) -> int:
    """Retorna quantos lembretes foram enviados (0 se nada a fazer)."""
    now = now or datetime.now()
    conn = db.connect()
    try:
        s = db.get_settings(conn)
        if not s["ntfy_topic"] or (not force and not s["ntfy_enabled"]):
            return 0
        today = now.date()
        if not force and (now.hour < int(s["notify_hour"]) or s["ntfy_last_sent"] == today.isoformat()):
            return 0
        items = logic.compute_reminders(conn, today)
        if items:
            title, message = build_message(items)
            priority = 4 if any(i["status"] != "upcoming" for i in items) else 3
            send_ntfy(s["ntfy_server"], s["ntfy_topic"], title, message, priority)
        elif force:
            send_ntfy(s["ntfy_server"], s["ntfy_topic"], "Finanças", "Tudo em dia! Nenhuma conta para os próximos dias. ✅")
        if not force:
            db.set_settings(conn, {"ntfy_last_sent": today.isoformat()})
        conn.commit()
        return len(items)
    finally:
        conn.close()


def _loop(interval: int) -> None:
    while True:
        try:
            check_and_send()
        except Exception:
            log.exception("Falha ao enviar lembretes")
        time.sleep(interval)


def start(interval: int = 600) -> None:
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="notifier").start()
