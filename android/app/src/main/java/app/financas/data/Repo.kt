package app.financas.data

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import java.util.UUID

/**
 * Operações sobre o banco — porta de backend/app/main.py + logic.py.
 * O mesmo arquivo .db é aberto pela web (Python) e por este app, então o SQL e as regras
 * precisam continuar idênticos aos do backend.
 * Compatível com o SQLite do Android 8 (3.18): sem UPSERT, sem window functions.
 */
class Repo(val db: Db, val today: () -> LocalDate = { LocalDate.now() }) {

    companion object {
        const val SCHEMA_VERSION = 3
        val DEFAULT_SETTINGS: Map<String, Any?> = mapOf(
            "reminder_days_default" to 3L, "notify_hour" to 8L, "ntfy_enabled" to false,
            "ntfy_server" to "https://ntfy.sh", "ntfy_topic" to "", "ntfy_last_sent" to "",
        )
        val GRID_COLUMNS = listOf("income", "bills", "daily", "savings", "card")
    }

    class NewerSchemaException(v: Int) :
        IllegalStateException("O arquivo foi criado por uma versão mais nova (v$v). Atualize o app.")

    // ================================================================= schema

    fun upgrade(schemaSql: String, seedSql: String) {
        val v = db.userVersion
        if (v > SCHEMA_VERSION) throw NewerSchemaException(v)
        db.script(schemaSql)
        if (v == 0) db.script(seedSql)
        for (t in listOf("transactions", "recurrences")) {
            if (db.query("PRAGMA table_info($t)").none { it["name"] == "nature" }) {
                db.exec("ALTER TABLE $t ADD COLUMN nature TEXT")
            }
        }
        if (v in 1..2) {
            db.exec(
                """DELETE FROM transactions WHERE recurrence_id IS NOT NULL AND paid = 0
                   AND card_id IS NULL AND recurrence_date >= ?""", today(),
            )
        }
        db.userVersion = SCHEMA_VERSION
    }

    // ================================================================= helpers

    private fun insert(table: String, data: Map<String, Any?>): Long {
        val cols = data.keys.joinToString(", ")
        val marks = data.keys.joinToString(", ") { "?" }
        return db.insert("INSERT INTO $table ($cols) VALUES ($marks)", *data.values.map(::sqlArg).toTypedArray())
    }

    private fun update(table: String, id: Long, data: Map<String, Any?>) {
        val sets = data.keys.joinToString(", ") { "$it = ?" }
        db.exec("UPDATE $table SET $sets WHERE id = ?", *(data.values.map(::sqlArg) + id).toTypedArray())
    }

    private fun normNature(kind: String, nature: String?) = if (kind == "expense" || nature == "saving") nature else null

    // ================================================================= configurações

    fun settings(): Map<String, Any?> =
        DEFAULT_SETTINGS + db.query("SELECT key, value FROM settings").associate { it.str("key") to Json.decode(it.str("value")) }

    fun setSettings(values: Map<String, Any?>) = db.tx {
        values.forEach { (k, v) -> db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", k, Json.encode(v)) }
    }

    fun reminderDaysDefault(): Int = (settings()["reminder_days_default"] as Number).toInt()
    fun notifyHour(): Int = (settings()["notify_hour"] as Number).toInt()

    // ================================================================= contas e categorias

    fun accounts(): List<Account> = db.query(
        """SELECT a.*, a.initial_balance
             + COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END)
                         FROM transactions t
                         WHERE t.account_id = a.id AND t.card_id IS NULL AND t.paid = 1), 0)
             - COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.account_id = a.id), 0)
             AS balance
           FROM accounts a ORDER BY a.archived, a.name""",
    ).map {
        Account(it.long("id"), it.str("name"), it.str("type"), it.long("initial_balance"), it.str("color"),
            it.bool("archived"), it.long("balance"))
    }

    fun saveAccount(id: Long?, a: AccountInput) {
        val data = mapOf("name" to a.name, "type" to a.type, "initial_balance" to a.initialBalance,
            "color" to a.color, "archived" to a.archived)
        if (id == null) insert("accounts", data) else update("accounts", id, data)
    }

    /** Exclui; se já tiver movimentações, apenas arquiva. Retorna true se arquivou. */
    fun deleteAccount(id: Long): Boolean {
        val used = db.one("SELECT 1 FROM transactions WHERE account_id = ? UNION SELECT 1 FROM invoice_payments WHERE account_id = ?", id, id) != null
        if (used) db.exec("UPDATE accounts SET archived = 1 WHERE id = ?", id) else db.exec("DELETE FROM accounts WHERE id = ?", id)
        return used
    }

    fun categories(kind: String? = null): List<Category> =
        (if (kind == null) db.query("SELECT * FROM categories ORDER BY kind, name")
        else db.query("SELECT * FROM categories WHERE kind = ? ORDER BY name", kind))
            .map { Category(it.long("id"), it.str("name"), it.str("kind"), it.str("color"), it.bool("archived")) }

    fun saveCategory(id: Long?, c: CategoryInput) {
        val data = mapOf("name" to c.name, "kind" to c.kind, "color" to c.color, "icon" to "", "archived" to c.archived)
        if (id == null) insert("categories", data) else update("categories", id, data)
    }

    fun deleteCategory(id: Long) = db.exec("DELETE FROM categories WHERE id = ?", id)

    // ================================================================= cartões e faturas

    private fun invoiceTotal(cardId: Long, month: String): Long = db.scalar(
        """SELECT COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount ELSE -amount END), 0)
           FROM transactions WHERE card_id = ? AND invoice_month = ?""", cardId, month,
    )

    private fun invoiceSummary(card: Row, month: String, t: LocalDate): Invoice {
        val payment = db.one("SELECT * FROM invoice_payments WHERE card_id = ? AND month = ?", card.long("id"), month)
        val closing = Dates.invoiceClosingDate(month, card.int("closing_day"), card.int("due_day"))
        val due = Dates.invoiceDueDate(month, card.int("due_day"))
        return Invoice(
            card.long("id"), card.str("name"), card.str("color"), month, invoiceTotal(card.long("id"), month),
            closing, due, payment != null, payment?.long("amount"), payment?.strOrNull("paid_date"),
            Dates.invoiceStatus(t, closing, due, payment != null),
        )
    }

    private fun usedLimit(cardId: Long): Long = db.scalar(
        """SELECT COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount ELSE -t.amount END), 0)
           FROM transactions t
           WHERE t.card_id = ? AND NOT EXISTS (
               SELECT 1 FROM invoice_payments ip WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)""",
        cardId,
    )

    private fun cardOut(r: Row, month: String?, t: LocalDate): Card {
        val current = month ?: Dates.invoiceMonthFor(t, r.int("closing_day"), r.int("due_day"))
        return Card(
            r.long("id"), r.str("name"), r.long("credit_limit"), r.int("closing_day"), r.int("due_day"), r.str("color"),
            r.longOrNull("account_id"), r.intOrNull("reminder_days"), r.bool("archived"), usedLimit(r.long("id")),
            invoiceSummary(r, current, t),
        )
    }

    /** Cartões; sem `month`, cada um traz a fatura atualmente aberta. */
    fun cards(month: String? = null): List<Card> {
        val t = today()
        ensureMonth(Dates.ym(t))
        ensureMonth(Dates.shiftYm(Dates.ym(t), 1))
        return db.query("SELECT * FROM cards ORDER BY archived, name").map { cardOut(it, month, t) }
    }

    fun saveCard(id: Long?, c: CardInput) = db.tx {
        val data = mapOf("name" to c.name, "credit_limit" to c.creditLimit, "closing_day" to c.closingDay,
            "due_day" to c.dueDay, "color" to c.color, "account_id" to c.accountId,
            "reminder_days" to c.reminderDays, "archived" to c.archived)
        if (id == null) return@tx insert("cards", data)
        val old = db.one("SELECT * FROM cards WHERE id = ?", id)!!
        update("cards", id, data)
        if (old.int("closing_day") != c.closingDay || old.int("due_day") != c.dueDay) {
            // recalcula a fatura dos lançamentos em faturas ainda não pagas
            db.query(
                """SELECT id, date FROM transactions t WHERE card_id = ? AND NOT EXISTS (
                     SELECT 1 FROM invoice_payments ip WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)""", id,
            ).forEach {
                db.exec("UPDATE transactions SET invoice_month = ? WHERE id = ?",
                    Dates.invoiceMonthFor(it.date("date"), c.closingDay, c.dueDay), it.long("id"))
            }
        }
        id
    }

    /** Exclui; se tiver lançamentos, apenas arquiva. Retorna true se arquivou. */
    fun deleteCard(id: Long): Boolean {
        val used = db.one("SELECT 1 FROM transactions WHERE card_id = ? LIMIT 1", id) != null
        if (used) db.exec("UPDATE cards SET archived = 1 WHERE id = ?", id) else db.exec("DELETE FROM cards WHERE id = ?", id)
        return used
    }

    fun invoice(cardId: Long, month: String? = null): Invoice {
        val card = db.one("SELECT * FROM cards WHERE id = ?", cardId)!!
        val t = today()
        val m = month ?: Dates.invoiceMonthFor(t, card.int("closing_day"), card.int("due_day"))
        for (k in -2..0) ensureMonth(Dates.shiftYm(m, k))
        val items = db.query("$TX_SELECT WHERE t.card_id = ? AND t.invoice_month = ? ORDER BY t.date, t.id", cardId, m).map(::tx)
        return invoiceSummary(card, m, t).copy(items = items)
    }

    fun payInvoice(cardId: Long, month: String, amount: Long? = null, paidDate: LocalDate? = null, accountId: Long? = null) {
        val card = db.one("SELECT * FROM cards WHERE id = ?", cardId)!!
        db.exec(
            "INSERT OR REPLACE INTO invoice_payments (card_id, month, amount, paid_date, account_id) VALUES (?, ?, ?, ?, ?)",
            cardId, month, amount ?: invoiceTotal(cardId, month), paidDate ?: today(),
            accountId ?: card.longOrNull("account_id"),
        )
    }

    fun unpayInvoice(cardId: Long, month: String) =
        db.exec("DELETE FROM invoice_payments WHERE card_id = ? AND month = ?", cardId, month)

    // ================================================================= recorrências

    fun occurrencesIn(r: Row, month: String) = Dates.occurrences(
        r.str("frequency"), r.intOrNull("day"), r.date("start_date"), r.dateOrNull("end_date"), month,
    )

    /** Cria (se ainda não existirem) os lançamentos das recorrências ativas no mês. */
    fun ensureMonth(month: String) = db.tx {
        val cards = db.query("SELECT * FROM cards").associateBy { it.long("id") }
        val skips = db.query("SELECT recurrence_id, date FROM recurrence_skips").map { it.long("recurrence_id") to it.str("date") }.toSet()
        for (rec in db.query("SELECT * FROM recurrences WHERE active = 1")) {
            for (d in occurrencesIn(rec, month)) {
                if ((rec.long("id") to d.toString()) in skips) continue
                val card = rec.longOrNull("card_id")?.let(cards::get)
                // contas (sem cartão) que vencem em fim de semana/feriado vão para o próximo dia útil
                val due = if (rec.str("kind") == "expense" && card == null) Dates.nextBusinessDay(d) else d
                db.exec(
                    """INSERT OR IGNORE INTO transactions
                       (kind, description, amount, date, category_id, account_id, card_id,
                        invoice_month, recurrence_id, recurrence_date, nature)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    rec.str("kind"), rec.str("description"), rec.long("amount"), sqlArg(due),
                    rec.longOrNull("category_id"), if (card != null) null else rec.longOrNull("account_id"),
                    card?.long("id"), card?.let { Dates.invoiceMonthFor(d, it.int("closing_day"), it.int("due_day")) },
                    rec.long("id"), sqlArg(d), rec.strOrNull("nature"),
                )
            }
        }
    }

    private fun clearFutureOccurrences(recurrenceId: Long) = db.exec(
        """DELETE FROM transactions
           WHERE recurrence_id = ? AND recurrence_date >= ? AND paid = 0
             AND (card_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM invoice_payments ip
                 WHERE ip.card_id = transactions.card_id AND ip.month = transactions.invoice_month))""",
        recurrenceId, today(),
    )

    fun recurrences(): List<Recurrence> {
        val t = today()
        val cur = Dates.ym(t)
        ensureMonth(cur)
        return db.query(
            """SELECT r.*, c.name AS category_name, c.color AS category_color,
                      a.name AS account_name, k.name AS card_name
               FROM recurrences r
               LEFT JOIN categories c ON c.id = r.category_id
               LEFT JOIN accounts a ON a.id = r.account_id
               LEFT JOIN cards k ON k.id = r.card_id
               ORDER BY r.active DESC, r.kind DESC, COALESCE(r.day, 99), r.description""",
        ).map { r ->
            val current = db.one(
                "$TX_SELECT WHERE t.recurrence_id = ? AND substr(t.recurrence_date, 1, 7) = ? ORDER BY t.date LIMIT 1",
                r.long("id"), cur,
            )?.let(::tx)
            val next = if (!r.bool("active")) null else
                (0..12).asSequence().map { occurrencesIn(r, Dates.shiftYm(cur, it)).firstOrNull { d -> d >= t } }.firstOrNull { it != null }
            Recurrence(
                r.long("id"), r.str("description"), r.str("kind"), r.str("bill_type"), r.long("amount"),
                r.longOrNull("category_id"), r.longOrNull("account_id"), r.longOrNull("card_id"), r.str("frequency"),
                r.intOrNull("day"), r.date("start_date"), r.dateOrNull("end_date"), r.intOrNull("reminder_days"),
                r.bool("active"), r.strOrNull("notes"), r.strOrNull("nature"), r.strOrNull("category_name"),
                r.strOrNull("category_color"), r.strOrNull("account_name"), r.strOrNull("card_name"), current, next,
            )
        }
    }

    /** Ao editar, ocorrências futuras não pagas são recriadas com os novos dados. */
    fun saveRecurrence(id: Long?, r: RecurrenceInput): Long = db.tx {
        val data = mapOf(
            "description" to r.description, "kind" to r.kind, "bill_type" to r.billType, "amount" to r.amount,
            "category_id" to r.categoryId, "account_id" to r.accountId, "card_id" to r.cardId,
            "frequency" to r.frequency, "day" to r.day, "start_date" to r.startDate, "end_date" to r.endDate,
            "reminder_days" to r.reminderDays, "active" to r.active, "notes" to r.notes,
            "nature" to normNature(r.kind, r.nature),
        )
        val rid = if (id == null) insert("recurrences", data) else {
            update("recurrences", id, data)
            clearFutureOccurrences(id)
            id
        }
        ensureMonth(Dates.ym(today()))
        rid
    }

    /** Remove a recorrência e as ocorrências futuras não pagas; o histórico pago fica. */
    fun deleteRecurrence(id: Long) = db.tx {
        clearFutureOccurrences(id)
        db.exec("DELETE FROM recurrences WHERE id = ?", id)
    }

    // ================================================================= lançamentos

    private val TX_SELECT = """
        SELECT t.id, t.kind, t.description, t.amount, t.date, t.category_id, t.account_id, t.card_id,
               t.invoice_month, t.paid_date, t.recurrence_id, t.recurrence_date, t.installment_group,
               t.installment_no, t.installment_total, t.reminder_days, t.notes, t.nature,
               CASE WHEN t.card_id IS NOT NULL THEN EXISTS (
                   SELECT 1 FROM invoice_payments ip WHERE ip.card_id = t.card_id AND ip.month = t.invoice_month)
               ELSE t.paid END AS paid,
               c.name AS category_name, c.color AS category_color,
               a.name AS account_name, k.name AS card_name, r.bill_type
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN accounts a ON a.id = t.account_id
        LEFT JOIN cards k ON k.id = t.card_id
        LEFT JOIN recurrences r ON r.id = t.recurrence_id
    """.trimIndent()

    private fun tx(r: Row) = Tx(
        r.long("id"), r.str("kind"), r.str("description"), r.long("amount"), r.date("date"),
        r.longOrNull("category_id"), r.longOrNull("account_id"), r.longOrNull("card_id"), r.strOrNull("invoice_month"),
        r.bool("paid"), r.strOrNull("paid_date"), r.longOrNull("recurrence_id"), r.strOrNull("installment_group"),
        r.intOrNull("installment_no"), r.intOrNull("installment_total"), r.intOrNull("reminder_days"),
        r.strOrNull("notes"), r.strOrNull("nature"), r.strOrNull("category_name"), r.strOrNull("category_color"),
        r.strOrNull("account_name"), r.strOrNull("card_name"), r.strOrNull("bill_type"),
    )

    fun transaction(id: Long): Tx? = db.one("$TX_SELECT WHERE t.id = ?", id)?.let(::tx)

    /** Lançamentos do mês pela data (compra ou vencimento), mais recentes primeiro. */
    fun transactions(month: String, kind: String? = null, status: String? = null, categoryId: Long? = null, q: String? = null): List<Tx> {
        ensureMonth(month)
        val where = mutableListOf("t.date BETWEEN ? AND ?")
        val args = mutableListOf<Any?>(Dates.first(month), Dates.last(month))
        kind?.let { where += "t.kind = ?"; args += it }
        categoryId?.let { where += "t.category_id = ?"; args += it }
        q?.takeIf { it.isNotBlank() }?.let { where += "t.description LIKE ?"; args += "%$it%" }
        var sql = "SELECT * FROM ($TX_SELECT WHERE ${where.joinToString(" AND ")})"
        status?.let { sql += " WHERE paid = ?"; args += if (it == "paid") 1L else 0L }
        return db.query("$sql ORDER BY date DESC, id DESC", *args.map(::sqlArg).toTypedArray()).map(::tx)
    }

    /** Normaliza campos: cartão define a fatura e ignora conta/pago. */
    private fun txFields(i: TxInput): MutableMap<String, Any?> {
        val data = mutableMapOf<String, Any?>(
            "kind" to i.kind, "description" to i.description, "amount" to i.amount, "date" to i.date,
            "category_id" to i.categoryId, "account_id" to i.accountId, "card_id" to i.cardId,
            "paid" to i.paid, "paid_date" to null, "reminder_days" to i.reminderDays, "notes" to i.notes,
            "nature" to normNature(i.kind, i.nature), "invoice_month" to null,
        )
        if (i.cardId != null) {
            val card = db.one("SELECT * FROM cards WHERE id = ?", i.cardId)!!
            data += mapOf("account_id" to null, "paid" to false,
                "invoice_month" to Dates.invoiceMonthFor(i.date, card.int("closing_day"), card.int("due_day")))
        } else if (i.paid) {
            data["paid_date"] = minOf(i.date, today())
        }
        return data
    }

    /** Cria um lançamento; com `installments` > 1 cria N parcelas mensais. Retorna os ids. */
    fun createTransaction(i: TxInput): List<Long> = db.tx {
        val base = txFields(i)
        val n = i.installments.coerceIn(1, 72)
        val group = if (n > 1) UUID.randomUUID().toString().replace("-", "") else null
        val each = if (i.amountMode == "installment") i.amount else i.amount / n
        val rest = if (i.amountMode == "installment") 0L else i.amount % n
        (0 until n).map { k ->
            val data = base.toMutableMap()
            data["date"] = i.date.plusMonths(k.toLong())
            data["amount"] = each + if (k == 0) rest else 0L
            if (n > 1) {
                data += mapOf("installment_group" to group, "installment_no" to k + 1, "installment_total" to n)
                if (k > 0) data += mapOf("paid" to false, "paid_date" to null)
            }
            if (i.cardId != null) data["invoice_month"] = Dates.shiftYm(base["invoice_month"] as String, k)
            insert("transactions", data)
        }
    }

    fun updateTransaction(id: Long, i: TxInput) {
        val data = txFields(i)
        data["updated_at"] = LocalDateTime.now().truncatedTo(ChronoUnit.SECONDS).toString()
        update("transactions", id, data)
    }

    /** Marca (ou desmarca) como pago/recebido. Lançamentos de cartão são quitados pela fatura. */
    fun payTransaction(id: Long, paid: Boolean = true, paidDate: LocalDate? = null, accountId: Long? = null, amount: Long? = null) {
        val t = db.one("SELECT card_id FROM transactions WHERE id = ?", id) ?: return
        require(t.longOrNull("card_id") == null) { "Lançamentos de cartão são quitados pelo pagamento da fatura" }
        val data = mutableMapOf<String, Any?>("paid" to paid, "paid_date" to if (paid) (paidDate ?: today()) else null)
        accountId?.let { data["account_id"] = it }
        amount?.let { data["amount"] = it }
        update("transactions", id, data)
    }

    /** scope: "one", "future" (esta e as próximas parcelas) ou "all". Retorna quantos foram excluídos. */
    fun deleteTransaction(id: Long, scope: String = "one"): Int = db.tx {
        val t = db.one("SELECT * FROM transactions WHERE id = ?", id) ?: return@tx 0
        val group = t.strOrNull("installment_group")
        val rows = when {
            group != null && scope == "future" -> db.query(
                "SELECT id, recurrence_id, recurrence_date FROM transactions WHERE installment_group = ? AND installment_no >= ?",
                group, t.long("installment_no"))
            group != null && scope == "all" -> db.query(
                "SELECT id, recurrence_id, recurrence_date FROM transactions WHERE installment_group = ?", group)
            else -> listOf(t)
        }
        for (r in rows) {
            r.longOrNull("recurrence_id")?.let {
                db.exec("INSERT OR IGNORE INTO recurrence_skips (recurrence_id, date) VALUES (?, ?)", it, r.str("recurrence_date"))
            }
            db.exec("DELETE FROM transactions WHERE id = ?", r.long("id"))
        }
        rows.size
    }

    // ================================================================= resumo

    /** Visão de caixa do mês: contas do mês + faturas que vencem no mês. */
    fun summary(month: String): Summary {
        val t = today()
        ensureMonth(Dates.shiftYm(month, -1))
        ensureMonth(month)
        val first = Dates.first(month)
        val last = Dates.last(month)
        val totals = HashMap<String, Long>()
        db.query(
            """SELECT kind, paid, SUM(amount) AS total FROM transactions
               WHERE card_id IS NULL AND date BETWEEN ? AND ? GROUP BY kind, paid""", first, last,
        ).forEach { totals["${it.str("kind")}:${it.long("paid")}"] = it.long("total") }
        fun tot(k: String) = totals[k] ?: 0L

        val invoices = db.query("SELECT * FROM cards ORDER BY name").map { invoiceSummary(it, month, t) }
            .filter { it.total != 0L || it.paid }
        val byCategory = db.query(
            """SELECT COALESCE(c.name, 'Sem categoria') AS name, COALESCE(c.color, '#94a3b8') AS color,
                      SUM(t.amount) AS total
               FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
               WHERE t.kind = 'expense' AND t.date BETWEEN ? AND ?
               GROUP BY c.id ORDER BY total DESC""", first, last,
        ).map { CategoryTotal(it.str("name"), it.str("color"), it.long("total")) }
        val pending = db.query(
            "$TX_SELECT WHERE t.card_id IS NULL AND t.paid = 0 AND t.date BETWEEN ? AND ? ORDER BY t.date, t.description",
            first, last,
        ).map(::tx)

        return Summary(
            month = month,
            incomeTotal = tot("income:0") + tot("income:1"),
            incomeReceived = tot("income:1"),
            expenseTotal = tot("expense:0") + tot("expense:1") + invoices.sumOf { it.total },
            expensePaid = tot("expense:1") + invoices.filter { it.paid }.sumOf { it.paidAmount ?: 0L },
            accountsBalance = accounts().filter { !it.archived }.sumOf { it.balance },
            byCategory = byCategory, invoices = invoices, pending = pending,
        )
    }

    // ================================================================= lembretes

    /**
     * Contas não pagas a lembrar. Sem `horizonDays`: só as que já entraram na janela de lembrete.
     * Com `horizonDays`: todas que vencem até lá.
     */
    fun reminders(horizonDays: Int? = null): List<Reminder> {
        val t = today()
        val defaultDays = reminderDaysDefault()
        val cur = Dates.ym(t)
        val lastMonth = Dates.ym(t.plusDays(maxOf(horizonDays ?: 0, 31).toLong()))
        val months = mutableListOf(Dates.shiftYm(cur, -2), Dates.shiftYm(cur, -1))
        while (months.last() < lastMonth) months += Dates.shiftYm(months.last(), 1)
        months.drop(1).forEach(::ensureMonth)
        fun include(days: Int, window: Int) = days <= (horizonDays ?: window)

        val items = mutableListOf<Reminder>()
        db.query(
            """SELECT t.id, t.description, t.amount, t.date, t.reminder_days, r.reminder_days AS rec_days
               FROM transactions t LEFT JOIN recurrences r ON r.id = t.recurrence_id
               WHERE t.card_id IS NULL AND t.kind = 'expense' AND t.paid = 0 AND t.date <= ?""",
            t.plusDays(maxOf(horizonDays ?: 0, 62).toLong()),
        ).forEach {
            val due = it.date("date")
            val days = Dates.daysBetween(t, due)
            val window = it.intOrNull("reminder_days") ?: it.intOrNull("rec_days") ?: defaultDays
            if (include(days, window)) {
                items += Reminder("transaction", it.long("id"), null, null, it.str("description"), it.long("amount"), due, days, window)
            }
        }
        for (card in db.query("SELECT * FROM cards WHERE archived = 0")) {
            val window = card.intOrNull("reminder_days") ?: defaultDays
            for (m in months) {
                val inv = invoiceSummary(card, m, t)
                if (inv.paid || inv.total <= 0) continue
                val days = Dates.daysBetween(t, inv.dueDate)
                if (include(days, window)) {
                    items += Reminder("invoice", null, card.long("id"), m, "Fatura ${card.str("name")}", inv.total, inv.dueDate, days, window)
                }
            }
        }
        return items.sortedWith(compareBy({ it.dueDate }, { it.description }))
    }

    // ================================================================= grade de saldos

    /** Saldo projetado dia a dia: tudo que está lançado na data (pago ou não) e cada fatura no vencimento. */
    fun grid(start: String, months: Int): Pair<Long, List<GridMonth>> {
        val monthList = (0 until months).map { Dates.shiftYm(start, it) }
        (listOf(Dates.shiftYm(start, -1)) + monthList).forEach(::ensureMonth)
        val first = Dates.first(monthList.first())
        val last = Dates.last(monthList.last())

        var opening = db.scalar("SELECT COALESCE(SUM(initial_balance), 0) FROM accounts") + db.scalar(
            """SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE -amount END), 0)
               FROM transactions WHERE card_id IS NULL AND date < ?""", first,
        )
        val buckets = HashMap<LocalDate, LongArray>() // income, bills, daily, savings, card
        fun bucket(d: LocalDate) = buckets.getOrPut(d) { LongArray(5) }

        val dueDays = db.query("SELECT id, due_day FROM cards").associate { it.long("id") to it.int("due_day") }
        val payments = db.query("SELECT card_id, month, amount FROM invoice_payments")
            .associate { (it.long("card_id") to it.str("month")) to it.long("amount") }
        db.query(
            """SELECT card_id, invoice_month, SUM(CASE WHEN kind = 'expense' THEN amount ELSE -amount END) AS total
               FROM transactions WHERE card_id IS NOT NULL GROUP BY card_id, invoice_month""",
        ).forEach {
            val dueDay = dueDays[it.long("card_id")] ?: return@forEach
            val due = Dates.invoiceDueDate(it.str("invoice_month"), dueDay)
            val amount = payments[it.long("card_id") to it.str("invoice_month")] ?: it.long("total")
            if (due < first) opening -= amount else if (due <= last) bucket(due)[4] += amount
        }
        db.query(
            "SELECT kind, nature, amount, date FROM transactions WHERE card_id IS NULL AND date BETWEEN ? AND ?", first, last,
        ).forEach {
            val income = it.str("kind") == "income"
            val nature = it.strOrNull("nature")
            val (col, sign) = when {
                income && nature == "saving" -> 3 to -1
                income -> 0 to 1
                nature == "daily" -> 2 to 1
                nature == "saving" -> 3 to 1
                else -> 1 to 1
            }
            bucket(it.date("date"))[col] += sign * it.long("amount")
        }

        var balance = opening
        val result = monthList.map { m ->
            val totals = LongArray(5)
            val days = generateSequence(Dates.first(m)) { it.plusDays(1) }.takeWhile { it <= Dates.last(m) }.map { d ->
                val b = buckets[d] ?: LongArray(5)
                balance += b[0] - b[1] - b[2] - b[3] - b[4]
                for (k in 0..4) totals[k] += b[k]
                GridDay(d, b[0], b[1], b[2], b[3], b[4], balance)
            }.toList()
            GridMonth(m, days, GRID_COLUMNS.zip(totals.toList()).toMap(), balance)
        }
        return opening to result
    }
}

/** Valores da tabela `settings` são JSON (gravados pelo Python com json.dumps). */
object Json {
    fun decode(s: String): Any? = when {
        s == "true" -> true
        s == "false" -> false
        s == "null" -> null
        s.startsWith("\"") -> unquote(s)
        else -> s.toLongOrNull() ?: s.toDoubleOrNull()
    }

    fun encode(v: Any?): String = when (v) {
        null -> "null"
        is Boolean, is Number -> v.toString()
        else -> buildString {
            append('"')
            for (ch in v.toString()) when {
                ch == '"' -> append("\\\"")
                ch == '\\' -> append("\\\\")
                ch < ' ' -> append("\\u%04x".format(ch.code))
                else -> append(ch)
            }
            append('"')
        }
    }

    private fun unquote(s: String): String {
        val out = StringBuilder()
        var i = 1
        while (i < s.length - 1) {
            val c = s[i]
            if (c != '\\') { out.append(c); i++; continue }
            when (val e = s[i + 1]) {
                'n' -> out.append('\n'); 't' -> out.append('\t'); 'r' -> out.append('\r')
                'b' -> out.append('\b'); 'f' -> out.append('\u000c')
                'u' -> { out.append(s.substring(i + 2, i + 6).toInt(16).toChar()); i += 4 }
                else -> out.append(e)
            }
            i += 2
        }
        return out.toString()
    }
}
