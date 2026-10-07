package app.financas.ui

import androidx.compose.ui.graphics.Color
import java.text.NumberFormat
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale

private val BR = Locale("pt", "BR")
private val BRL = NumberFormat.getCurrencyInstance(BR)
private val MONTHS = listOf("Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
    "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro")
private val DMY = DateTimeFormatter.ofPattern("dd/MM/yyyy")
private val DM = DateTimeFormatter.ofPattern("dd/MM")
private val WEEKDAY = DateTimeFormatter.ofPattern("EEE", BR)

fun money(cents: Long): String = BRL.format(cents / 100.0)

/** "1.234,56", "1234.56", "R$ 12" -> centavos. */
fun parseMoney(s: String): Long? {
    var t = s.replace(Regex("[^\\d,.-]"), "")
    if (',' in t) t = t.replace(".", "").replace(',', '.')
    return t.toDoubleOrNull()?.let { Math.round(it * 100) }
}

fun centsInput(c: Long?): String = c?.let { "%.2f".format(Locale.US, it / 100.0).replace('.', ',') } ?: ""

fun monthLabel(m: String): String = YearMonth.parse(m).let { "${MONTHS[it.monthValue - 1]} ${it.year}" }
fun monthShort(m: String): String = YearMonth.parse(m).let { "${MONTHS[it.monthValue - 1].take(3)}/${it.year % 100}" }
fun dmy(d: LocalDate): String = d.format(DMY)
fun dm(d: LocalDate): String = d.format(DM)
fun dayHeader(d: LocalDate): String =
    if (d == LocalDate.now()) "Hoje" else "${d.format(WEEKDAY).replaceFirstChar(Char::uppercase)}, ${dmy(d)}"

fun dueLabel(days: Int): String = when {
    days < -1 -> "venceu há ${-days} dias"
    days == -1 -> "venceu ontem"
    days == 0 -> "vence hoje"
    days == 1 -> "vence amanhã"
    else -> "vence em $days dias"
}

fun hexColor(s: String?): Color =
    runCatching { Color(android.graphics.Color.parseColor(s ?: "#94a3b8")) }.getOrDefault(Color.Gray)

val BILL_TYPES = linkedMapOf("fixa" to "Conta fixa", "boleto" to "Boleto", "assinatura" to "Assinatura",
    "debito" to "Débito automático", "outro" to "Outro")
val FREQUENCIES = linkedMapOf("monthly" to "Mensal", "weekly" to "Semanal", "yearly" to "Anual")
val ACCOUNT_TYPES = linkedMapOf("checking" to "Conta corrente", "savings" to "Poupança", "wallet" to "Carteira",
    "investment" to "Investimento", "other" to "Outra")
val INVOICE_STATUS = mapOf("aberta" to "Aberta", "fechada" to "Fechada", "paga" to "Paga", "vencida" to "Vencida")

fun natures(kind: String): List<Pair<String?, String>> =
    if (kind == "expense") listOf("daily" to "Gasto diário", "bill" to "Saída / conta", "saving" to "Economia (guardar)")
    else listOf(null to "Entrada", "saving" to "Resgate de economia")

val PALETTE = listOf("#6750a4", "#6366f1", "#0ea5e9", "#14b8a6", "#22c55e", "#84cc16", "#eab308",
    "#f97316", "#ef4444", "#ec4899", "#8b5cf6", "#64748b")
