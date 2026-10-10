-- Schema compartilhado entre o backend (Python) e o app Android.
-- Valores em centavos; datas AAAA-MM-DD; meses AAAA-MM.
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
    nature        TEXT,
    -- vencimento em fim de semana/feriado: next (adia), previous (antecipa), none (mantém).
    -- NULL = padrão: despesa sem cartão adia; receita e cartão mantêm.
    due_shift     TEXT
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
