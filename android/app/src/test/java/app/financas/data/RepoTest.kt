package app.financas.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.sql.Connection
import java.sql.DriverManager
import java.time.LocalDate

/** Db sobre JDBC (sqlite-jdbc) para rodar as regras na JVM, sem Android. */
class JdbcDb(url: String = "jdbc:sqlite::memory:") : Db {
    private val conn: Connection = DriverManager.getConnection(url).apply {
        createStatement().use { it.execute("PRAGMA foreign_keys = ON") }
    }
    private var depth = 0

    private fun prepare(sql: String, args: Array<out Any?>) = conn.prepareStatement(sql).apply {
        args.forEachIndexed { i, a -> setObject(i + 1, sqlArg(a)) }
    }

    override fun query(sql: String, vararg args: Any?): List<Row> = prepare(sql, args).use { st ->
        st.executeQuery().use { rs ->
            val md = rs.metaData
            buildList { while (rs.next()) add((1..md.columnCount).associate { md.getColumnLabel(it) to rs.getObject(it) }) }
        }
    }

    override fun exec(sql: String, vararg args: Any?) {
        prepare(sql, args).use { it.execute() }
    }

    override fun <T> tx(block: () -> T): T {
        if (depth++ == 0) conn.autoCommit = false
        try {
            val r = block()
            if (--depth == 0) { conn.commit(); conn.autoCommit = true }
            return r
        } catch (e: Throwable) {
            if (--depth == 0) { conn.rollback(); conn.autoCommit = true }
            throw e
        }
    }

    override var userVersion: Int
        get() = scalar("PRAGMA user_version").toInt()
        set(v) = exec("PRAGMA user_version = $v")
}

class RepoTest {
    private val today = LocalDate.of(2026, 10, 5)
    private lateinit var repo: Repo
    private val sqlDir = File("../../frontend/sql")

    @Before
    fun setUp() {
        repo = Repo(JdbcDb()) { today }
        repo.upgrade(File(sqlDir, "schema.sql").readText(), File(sqlDir, "seed.sql").readText())
    }

    private fun acc() = repo.accounts().first().id

    @Test
    fun seed() {
        assertEquals(1, repo.accounts().size)
        assertEquals(16, repo.categories().size)
        assertEquals(3, repo.reminderDaysDefault())
    }

    @Test
    fun invoiceMonthAndBusinessDays() {
        fun inv(d: String, c: Int, due: Int) = Dates.invoiceMonthFor(LocalDate.parse(d), c, due)
        assertEquals("2026-10", inv("2026-10-03", 5, 15))
        assertEquals("2026-11", inv("2026-10-05", 5, 15))
        assertEquals("2026-11", inv("2026-10-20", 28, 5))
        assertEquals("2027-02", inv("2026-12-30", 28, 5))
        assertEquals("2026-04", inv("2026-02-28", 31, 10))
        assertEquals(LocalDate.of(2027, 3, 28), Dates.easter(2027))
        assertEquals(LocalDate.of(2026, 10, 13), Dates.nextBusinessDay(LocalDate.of(2026, 10, 10)))
        assertEquals(LocalDate.of(2027, 2, 10), Dates.nextBusinessDay(LocalDate.of(2027, 2, 8)))
        assertEquals(
            listOf(2, 9, 16, 23, 30).map { LocalDate.of(2026, 10, it) },
            Dates.occurrences("weekly", null, LocalDate.of(2026, 10, 2), null, "2026-10"),
        )
        assertEquals(listOf(LocalDate.of(2026, 2, 28)), Dates.occurrences("monthly", null, LocalDate.of(2026, 1, 31), null, "2026-02"))
    }

    @Test
    fun expenseAndBalance() {
        repo.createTransaction(TxInput("income", "Salário", 500000, LocalDate.of(2026, 10, 1), accountId = acc(), paid = true))
        repo.createTransaction(TxInput("expense", "Mercado", 25050, LocalDate.of(2026, 10, 4), accountId = acc(), paid = true))
        assertEquals(500000L - 25050, repo.accounts().first().balance)
        val s = repo.summary("2026-10")
        assertEquals(500000L, s.incomeReceived)
        assertEquals(25050L, s.expensePaid)
    }

    @Test
    fun cardInstallmentsAndInvoice() {
        val card = repo.saveCard(null, CardInput("Nubank", 500000, 28, 5, accountId = acc()))
        val ids = repo.createTransaction(TxInput("expense", "TV", 100000, LocalDate.of(2026, 10, 10), cardId = card, installments = 3))
        val txs = ids.map { repo.transaction(it)!! }
        assertEquals(listOf("2026-11", "2026-12", "2027-01"), txs.map { it.invoiceMonth })
        assertEquals(listOf(33334L, 33333L, 33333L), txs.map { it.amount })

        val inv = repo.invoice(card, "2026-11")
        assertEquals(33334L, inv.total)
        assertEquals("aberta", inv.status)
        assertEquals(LocalDate.of(2026, 11, 5), inv.dueDate)

        repo.payInvoice(card, "2026-11")
        assertEquals(-33334L, repo.accounts().first().balance)
        assertEquals(66666L, repo.cards().first().usedLimit)
        assertTrue(repo.transactions("2026-10").first().paid)
        assertEquals(2, repo.deleteTransaction(ids[1], "future"))

        val perInstallment = repo.createTransaction(
            TxInput("expense", "Geladeira", 25000, LocalDate.of(2026, 10, 5), cardId = card, installments = 4, amountMode = "installment"))
        assertEquals(List(4) { 25000L }, perInstallment.map { repo.transaction(it)!!.amount })
    }

    @Test
    fun recurrencesSkipAndReminders() {
        val rec = repo.saveRecurrence(null, RecurrenceInput("Internet", amount = 9990, day = 7,
            startDate = LocalDate.of(2026, 10, 1), accountId = acc(), billType = "boleto", reminderDays = 3))
        val r = repo.recurrences().first()
        assertEquals(LocalDate.of(2026, 10, 7), r.nextDate)
        assertEquals(listOf("Internet" to 2), repo.reminders().map { it.description to it.daysUntil })

        val oct = repo.transactions("2026-10").single()
        repo.payTransaction(oct.id, amount = 10500)
        assertTrue(repo.reminders().isEmpty())

        // 07/11/2026 é sábado -> segunda 09/11; excluir não deve recriar
        val nov = repo.transactions("2026-11").single()
        assertEquals(LocalDate.of(2026, 11, 9), nov.date)
        repo.deleteTransaction(nov.id)
        assertTrue(repo.transactions("2026-11").isEmpty())

        repo.saveRecurrence(rec, RecurrenceInput("Internet", amount = 12000, day = 7,
            startDate = LocalDate.of(2026, 10, 1), accountId = acc(), billType = "boleto", reminderDays = 3))
        assertEquals(12000L, repo.transactions("2026-12").single().amount)
        assertEquals(10500L, repo.transactions("2026-10").single().amount)

        val upcoming = repo.reminders(horizonDays = 90)
        assertEquals(listOf(LocalDate.of(2026, 12, 7)), upcoming.map { it.dueDate }) // 07/01 passa dos 90 dias
    }

    @Test
    fun dailyGrid() {
        repo.saveAccount(acc(), AccountInput("Conta", initialBalance = 100000))
        val card = repo.saveCard(null, CardInput("C", closingDay = 28, dueDay = 6))
        fun add(kind: String, amount: Long, d: String, nature: String? = null, cardId: Long? = null) =
            repo.createTransaction(TxInput(kind, "x", amount, LocalDate.parse(d), accountId = acc(), nature = nature, cardId = cardId))
        add("income", 50000, "2026-10-06")
        add("expense", 20000, "2026-10-10")
        add("expense", 3000, "2026-10-10", "daily")
        add("expense", 10000, "2026-10-15", "saving")
        add("income", 4000, "2026-10-20", "saving")
        add("expense", 7000, "2026-09-20", cardId = card)
        add("expense", 500, "2026-09-30")

        val (opening, months) = repo.grid("2026-10", 2)
        assertEquals(99500L, opening)
        val day = months[0].days.associateBy { it.date.dayOfMonth }
        assertEquals(7000L, day[6]!!.card)
        assertEquals(99500L + 50000 - 7000, day[6]!!.balance)
        assertEquals(3000L, day[10]!!.daily)
        assertEquals(6000L, months[0].totals["savings"])
        assertEquals(99500L + 50000 - 7000 - 20000 - 3000 - 6000, months[0].endBalance)
    }

    @Test
    fun settingsJsonCompatibleWithPython() {
        repo.setSettings(mapOf("reminder_days_default" to 5L, "ntfy_topic" to "olá \"x\""))
        assertEquals(5, repo.reminderDaysDefault())
        assertEquals("olá \"x\"", repo.settings()["ntfy_topic"])
        assertEquals("ação", Json.decode("\"a\\u00e7\\u00e3o\"")) // formato do json.dumps do Python
    }
}
