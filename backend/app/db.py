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

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'checking',
    initial_balance INTEGER NOT NULL DEFAULT 0,
    color           TEXT NOT NULL DEFAULT '#4f46e5',
    archived        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    kind     TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    color    TEXT NOT NULL DEFAULT '#64748b',
    icon     TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    credit_limit  INTEGER NOT NULL DEFAULT 0,
    closing_day   INTEGER NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
    due_day       INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    color         TEXT NOT NULL DEFAULT '#0ea5e9',
    account_id    INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    reminder_days INTEGER,
    archived      INTEGER NOT NULL DEFAULT 0
);

-- Contas fixas / recorrentes (aluguel, internet, assinaturas, boletos, salário...)
CREATE TABLE IF NOT EXISTS recurrences (
    id            INTEGER PRIMARY KEY,
    description   TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income')),
    bill_type     TEXT NOT NULL DEFAULT 'fixa',
    amount        INTEGER NOT NULL CHECK (amount >= 0),
    category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    account_id    INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    card_id       INTEGER REFERENCES cards(id) ON DELETE SET NULL,
    frequency     TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
    day           INTEGER CHECK (day BETWEEN 1 AND 31),
    start_date    TEXT NOT NULL,
    end_date      TEXT,
    reminder_days INTEGER,
    active        INTEGER NOT NULL DEFAULT 1,
    notes         TEXT,
    nature        TEXT
);

-- Ocorrências de recorrências que o usuário excluiu (para não serem recriadas)
CREATE TABLE IF NOT EXISTS recurrence_skips (
    recurrence_id INTEGER NOT NULL REFERENCES recurrences(id) ON DELETE CASCADE,
    date          TEXT NOT NULL,
    PRIMARY KEY (recurrence_id, date)
);

CREATE TABLE IF NOT EXISTS transactions (
    id                INTEGER PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    description       TEXT NOT NULL,
    amount            INTEGER NOT NULL CHECK (amount >= 0),
    date              TEXT NOT NULL,          -- data da compra / vencimento
    category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    account_id        INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    card_id           INTEGER REFERENCES cards(id) ON DELETE SET NULL,
    invoice_month     TEXT,                   -- mês de vencimento da fatura (se cartão)
    paid              INTEGER NOT NULL DEFAULT 0,
    paid_date         TEXT,
    recurrence_id     INTEGER REFERENCES recurrences(id) ON DELETE SET NULL,
    recurrence_date   TEXT,                   -- data original agendada pela recorrência
    installment_group TEXT,
    installment_no    INTEGER,
    installment_total INTEGER,
    reminder_days     INTEGER,
    notes             TEXT,
    nature            TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tx_recurrence
    ON transactions (recurrence_id, recurrence_date) WHERE recurrence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tx_date ON transactions (date);
CREATE INDEX IF NOT EXISTS ix_tx_invoice ON transactions (card_id, invoice_month);
CREATE INDEX IF NOT EXISTS ix_tx_group ON transactions (installment_group);

CREATE TABLE IF NOT EXISTS invoice_payments (
    id         INTEGER PRIMARY KEY,
    card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    month      TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    paid_date  TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    UNIQUE (card_id, month)
);
"""

DEFAULT_SETTINGS = {
    "reminder_days_default": 3,
    "notify_hour": 8,
    "ntfy_enabled": False,
    "ntfy_server": "https://ntfy.sh",
    "ntfy_topic": "",
    "ntfy_last_sent": "",
}

DEFAULT_CATEGORIES = [
    ("Moradia", "expense", "#6366f1"),
    ("Contas de consumo", "expense", "#0ea5e9"),
    ("Mercado", "expense", "#22c55e"),
    ("Alimentação", "expense", "#f97316"),
    ("Transporte", "expense", "#eab308"),
    ("Saúde", "expense", "#ef4444"),
    ("Educação", "expense", "#8b5cf6"),
    ("Lazer", "expense", "#ec4899"),
    ("Assinaturas", "expense", "#14b8a6"),
    ("Compras", "expense", "#f43f5e"),
    ("Impostos e taxas", "expense", "#78716c"),
    ("Outros", "expense", "#64748b"),
    ("Salário", "income", "#16a34a"),
    ("Freelance", "income", "#0891b2"),
    ("Investimentos", "income", "#7c3aed"),
    ("Outras receitas", "income", "#64748b"),
]


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
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
    if not conn.execute("SELECT 1 FROM categories LIMIT 1").fetchone():
        conn.executemany(
            "INSERT INTO categories (name, kind, color) VALUES (?, ?, ?)",
            DEFAULT_CATEGORIES,
        )
    if not conn.execute("SELECT 1 FROM accounts LIMIT 1").fetchone():
        conn.execute("INSERT INTO accounts (name, type) VALUES ('Conta principal', 'checking')")


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
