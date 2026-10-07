package app.financas.data

import java.time.LocalDate

// Valores monetários sempre em centavos (Long).

data class Account(
    val id: Long, val name: String, val type: String, val initialBalance: Long,
    val color: String, val archived: Boolean, val balance: Long,
)

data class Category(val id: Long, val name: String, val kind: String, val color: String, val archived: Boolean)

data class Invoice(
    val cardId: Long, val cardName: String, val color: String, val month: String, val total: Long,
    val closingDate: LocalDate, val dueDate: LocalDate, val paid: Boolean, val paidAmount: Long?,
    val paidDate: String?, val status: String, val items: List<Tx> = emptyList(),
)

data class Card(
    val id: Long, val name: String, val creditLimit: Long, val closingDay: Int, val dueDay: Int,
    val color: String, val accountId: Long?, val reminderDays: Int?, val archived: Boolean,
    val usedLimit: Long, val currentInvoice: Invoice,
) {
    val availableLimit get() = creditLimit - usedLimit
}

data class Tx(
    val id: Long, val kind: String, val description: String, val amount: Long, val date: LocalDate,
    val categoryId: Long?, val accountId: Long?, val cardId: Long?, val invoiceMonth: String?,
    val paid: Boolean, val paidDate: String?, val recurrenceId: Long?, val installmentGroup: String?,
    val installmentNo: Int?, val installmentTotal: Int?, val reminderDays: Int?, val notes: String?,
    val nature: String?, val categoryName: String?, val categoryColor: String?, val accountName: String?,
    val cardName: String?, val billType: String?,
) {
    /** Coluna da grade de saldos: income, bills, daily, savings ou card. */
    val gridColumn: String
        get() = when {
            cardId != null -> "card"
            kind == "income" -> if (nature == "saving") "savings" else "income"
            nature == "daily" -> "daily"
            nature == "saving" -> "savings"
            else -> "bills"
        }
}

data class Recurrence(
    val id: Long, val description: String, val kind: String, val billType: String, val amount: Long,
    val categoryId: Long?, val accountId: Long?, val cardId: Long?, val frequency: String, val day: Int?,
    val startDate: LocalDate, val endDate: LocalDate?, val reminderDays: Int?, val active: Boolean,
    val notes: String?, val nature: String?, val categoryName: String?, val categoryColor: String?,
    val accountName: String?, val cardName: String?,
    /** Ocorrência deste mês (se houver). */
    val current: Tx?, val nextDate: LocalDate?,
)

data class CategoryTotal(val name: String, val color: String, val total: Long)

data class Summary(
    val month: String, val incomeTotal: Long, val incomeReceived: Long, val expenseTotal: Long,
    val expensePaid: Long, val accountsBalance: Long, val byCategory: List<CategoryTotal>,
    val invoices: List<Invoice>, val pending: List<Tx>,
) {
    val balanceForecast get() = incomeTotal - expenseTotal
    val balanceRealized get() = incomeReceived - expensePaid
}

data class Reminder(
    val type: String, // "transaction" ou "invoice"
    val txId: Long?, val cardId: Long?, val month: String?, val description: String, val amount: Long,
    val dueDate: LocalDate, val daysUntil: Int, val remindDays: Int,
) {
    val key get() = if (type == "invoice") "inv:$cardId:$month" else "tx:$txId"
}

data class GridDay(
    val date: LocalDate, val income: Long, val bills: Long, val daily: Long, val savings: Long,
    val card: Long, val balance: Long,
) {
    fun value(col: String): Long = when (col) {
        "income" -> income; "bills" -> bills; "daily" -> daily; "savings" -> savings; else -> card
    }
}

data class GridMonth(val month: String, val days: List<GridDay>, val totals: Map<String, Long>, val endBalance: Long)

// ------------------------------------------------------------------ entradas de formulário

data class TxInput(
    val kind: String, val description: String, val amount: Long, val date: LocalDate,
    val categoryId: Long? = null, val accountId: Long? = null, val cardId: Long? = null,
    val paid: Boolean = false, val reminderDays: Int? = null, val notes: String? = null,
    val nature: String? = null, val installments: Int = 1, val amountMode: String = "total",
)

data class RecurrenceInput(
    val description: String, val kind: String = "expense", val billType: String = "fixa", val amount: Long,
    val categoryId: Long? = null, val accountId: Long? = null, val cardId: Long? = null,
    val frequency: String = "monthly", val day: Int? = null, val startDate: LocalDate,
    val endDate: LocalDate? = null, val reminderDays: Int? = null, val active: Boolean = true,
    val notes: String? = null, val nature: String? = null,
)

data class CardInput(
    val name: String, val creditLimit: Long = 0, val closingDay: Int, val dueDay: Int,
    val color: String = "#0ea5e9", val accountId: Long? = null, val reminderDays: Int? = null,
    val archived: Boolean = false,
)

data class AccountInput(
    val name: String, val type: String = "checking", val initialBalance: Long = 0,
    val color: String = "#4f46e5", val archived: Boolean = false,
)

data class CategoryInput(val name: String, val kind: String, val color: String = "#64748b", val archived: Boolean = false)
