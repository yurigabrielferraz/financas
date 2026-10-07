package app.financas.data

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.ChronoUnit

/** Regras de datas, dias úteis e faturas — mesmas de backend/app/logic.py. */
object Dates {
    fun ym(d: LocalDate): String = YearMonth.from(d).toString()
    fun shiftYm(month: String, n: Int): String = YearMonth.parse(month).plusMonths(n.toLong()).toString()

    /** Dia `day` do mês; se o mês for mais curto, usa o último dia (31 -> 28/fev). */
    fun clamp(month: YearMonth, day: Int): LocalDate = month.atDay(minOf(day, month.lengthOfMonth()))

    fun first(month: String): LocalDate = YearMonth.parse(month).atDay(1)
    fun last(month: String): LocalDate = YearMonth.parse(month).atEndOfMonth()
    fun daysBetween(a: LocalDate, b: LocalDate): Int = ChronoUnit.DAYS.between(a, b).toInt()

    // ------------------------------------------------------------ dias úteis

    private val FIXED_HOLIDAYS = listOf(1 to 1, 4 to 21, 5 to 1, 9 to 7, 10 to 12, 11 to 2, 11 to 15, 11 to 20, 12 to 25)
    private val holidayCache = HashMap<Int, Set<LocalDate>>()

    /** Domingo de Páscoa (Meeus/Jones/Butcher). */
    fun easter(year: Int): LocalDate {
        val a = year % 19; val b = year / 100; val c = year % 100
        val d = b / 4; val e = b % 4
        val f = (b + 8) / 25
        val g = (b - f + 1) / 3
        val h = (19 * a + b - d - g + 15) % 30
        val i = c / 4; val k = c % 4
        val l = (32 + 2 * e + 2 * i - h - k) % 7
        val m = (a + 11 * h + 22 * l) / 451
        val month = (h + l - 7 * m + 114) / 31
        val day = (h + l - 7 * m + 114) % 31 + 1
        return LocalDate.of(year, month, day)
    }

    /** Feriados nacionais + dias sem expediente bancário (Carnaval, Sexta-feira Santa, Corpus Christi). */
    fun holidays(year: Int): Set<LocalDate> = synchronized(holidayCache) {
        holidayCache.getOrPut(year) {
            val e = easter(year)
            FIXED_HOLIDAYS.map { (m, d) -> LocalDate.of(year, m, d) }.toSet() +
                setOf(e.minusDays(48), e.minusDays(47), e.minusDays(2), e.plusDays(60))
        }
    }

    fun isBusinessDay(d: LocalDate): Boolean =
        d.dayOfWeek != DayOfWeek.SATURDAY && d.dayOfWeek != DayOfWeek.SUNDAY && d !in holidays(d.year)

    fun nextBusinessDay(d: LocalDate): LocalDate {
        var x = d
        while (!isBusinessDay(x)) x = x.plusDays(1)
        return x
    }

    // ------------------------------------------------------------ cartões

    /** Mês (AAAA-MM) em que vence a fatura de uma compra. Compras no dia do fechamento ou depois vão para a seguinte. */
    fun invoiceMonthFor(purchase: LocalDate, closingDay: Int, dueDay: Int): String {
        val closing = clamp(YearMonth.from(purchase), closingDay)
        val closingMonth = if (purchase < closing) ym(purchase) else shiftYm(ym(purchase), 1)
        return if (dueDay > closingDay) closingMonth else shiftYm(closingMonth, 1)
    }

    fun invoiceClosingDate(month: String, closingDay: Int, dueDay: Int): LocalDate =
        clamp(YearMonth.parse(if (dueDay > closingDay) month else shiftYm(month, -1)), closingDay)

    fun invoiceDueDate(month: String, dueDay: Int): LocalDate = nextBusinessDay(clamp(YearMonth.parse(month), dueDay))

    fun invoiceStatus(today: LocalDate, closing: LocalDate, due: LocalDate, paid: Boolean): String = when {
        paid -> "paga"
        today > due -> "vencida"
        today >= closing -> "fechada"
        else -> "aberta"
    }

    // ------------------------------------------------------------ recorrências

    fun occurrences(frequency: String, day: Int?, start: LocalDate, end: LocalDate?, month: String): List<LocalDate> {
        val ymo = YearMonth.parse(month)
        val target = day ?: start.dayOfMonth
        val dates = when (frequency) {
            "monthly" -> listOf(clamp(ymo, target))
            "yearly" -> if (ymo.monthValue == start.monthValue) listOf(clamp(ymo, target)) else emptyList()
            else -> { // weekly: mesmo dia da semana da data de início
                val first = ymo.atDay(1)
                val offset = Math.floorMod(daysBetween(start, first), 7)
                generateSequence(first.plusDays(((7 - offset) % 7).toLong())) { it.plusDays(7) }
                    .takeWhile { it <= ymo.atEndOfMonth() }.toList()
            }
        }
        return dates.filter { it >= start && (end == null || it <= end) }
    }
}
