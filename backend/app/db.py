"""Conexão SQLite, schema e dados iniciais.

Valores monetários são sempre armazenados em centavos (INTEGER).
Datas são strings ISO (YYYY-MM-DD) e meses são YYYY-MM.
"""
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(
    os.environ.get(
        "FINANCAS_DB",
        Path(__file__).resolve().parent.parent / "data" / "financas.db",
    )
)

SCHEMA_VERSION = 3

# Classificação das despesas na grade de saldos:
#   bill = saída (contas, boletos)   daily = gasto diário   saving = economia (guardar)
# Em receitas, nature = saving significa resgate de economia.
NATURES = ("bill", "daily", "saving")

SQL_DIR = Path(__file__).resolve().parent / "sql"
SCHEMA = (SQL_DIR / "schema.sql").read_text()
SEED = (SQL_DIR / "seed.sql").read_text()

DEFAULT_SETTINGS = {
    "reminder_days_default": 3,
    "notify_hour": 8,
    "ntfy_enabled": False,
    "ntfy_server": "https://ntfy.sh",
    "ntfy_topic": "",
    "ntfy_last_sent": "",
}



def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # arquivo único (sem -wal/-shm): o banco pode ficar numa pasta sincronizada (Google Drive)
    # e ser aberto também pelo app Android
    conn.execute("PRAGMA journal_mode = DELETE")
    return conn


def init_db() -> None:
    conn = connect()
    try:
        upgrade(conn)
    finally:
        conn.close()


def upgrade(conn: sqlite3.Connection) -> None:
    """Cria/atualiza o schema de um banco (o principal ou um backup sendo importado)."""
    conn.executescript(SCHEMA)
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version == 0:
        seed(conn)
    _migrate(conn, version)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def _migrate(conn: sqlite3.Connection, version: int) -> None:
    # v2: coluna `nature` (saída / diário / economia)
    for table in ("transactions", "recurrences"):
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if "nature" not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN nature TEXT")
    if 0 < version < 3:
        # v3: vencimentos em dia útil — remove ocorrências futuras não pagas para serem regeradas
        conn.execute(
            """DELETE FROM transactions WHERE recurrence_id IS NOT NULL AND paid = 0
               AND card_id IS NULL AND recurrence_date >= date('now', 'localtime')"""
        )


def seed(conn: sqlite3.Connection) -> None:
    conn.executescript(SEED)


DATA_TABLES = ("transactions", "recurrence_skips", "recurrences", "invoice_payments", "cards", "categories", "accounts")


def reset_data(conn: sqlite3.Connection) -> None:
    """Apaga todos os dados financeiros e recria as categorias/conta padrão. Mantém as configurações."""
    for table in DATA_TABLES:
        conn.execute(f"DELETE FROM {table}")
    seed(conn)


# ordem de inserção respeitando as chaves estrangeiras (pais primeiro)
RESTORE_ORDER = ("accounts", "categories", "cards", "recurrences", "recurrence_skips",
                 "transactions", "invoice_payments", "settings")


def snapshot(conn: sqlite3.Connection, label: str) -> Path:
    """Salva uma cópia do banco atual em data/backups/ e retorna o caminho."""
    folder = DB_PATH.parent / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{label}-{datetime.now():%Y%m%d-%H%M%S}.db"
    dst = sqlite3.connect(path)
    try:
        conn.backup(dst)
    finally:
        dst.close()
    return path


def validate_backup(path: str) -> None:
    """Confere se o arquivo é um banco deste app e o atualiza para o schema atual."""
    src = sqlite3.connect(path)
    try:
        try:
            tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        except sqlite3.DatabaseError:
            raise ValueError("Arquivo corrompido ou não é um banco SQLite")
        missing = set(DATA_TABLES) - tables
        if missing:
            raise ValueError("O arquivo não parece ser um backup deste app (faltam tabelas: "
                             + ", ".join(sorted(missing)) + ")")
        upgrade(src)
    finally:
        src.close()


def restore_from(conn: sqlite3.Connection, path: str) -> dict[str, int]:
    """Substitui todos os dados (e configurações) pelos do backup. Tudo ou nada."""
    conn.commit()
    conn.execute("ATTACH DATABASE ? AS src", (path,))
    try:
        counts = {}
        with conn:
            for table in DATA_TABLES + ("settings",):
                conn.execute(f"DELETE FROM main.{table}")
            for table in RESTORE_ORDER:
                main_cols = [r[1] for r in conn.execute(f"PRAGMA main.table_info({table})")]
                src_cols = {r[1] for r in conn.execute(f"PRAGMA src.table_info({table})")}
                cols = ", ".join(c for c in main_cols if c in src_cols)
                conn.execute(f"INSERT INTO main.{table} ({cols}) SELECT {cols} FROM src.{table}")
                counts[table] = conn.execute(f"SELECT COUNT(*) FROM main.{table}").fetchone()[0]
    finally:
        conn.execute("DETACH DATABASE src")
    return counts


def get_settings(conn: sqlite3.Connection) -> dict:
    values = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key, value FROM settings"):
        values[row["key"]] = json.loads(row["value"])
    return values


def set_settings(conn: sqlite3.Connection, values: dict) -> None:
    conn.executemany(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [(k, json.dumps(v)) for k, v in values.items()],
    )
