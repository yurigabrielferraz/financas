package app.financas.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import java.time.LocalDate

/** Linha de lista sem fundo próprio (para usar dentro de cards). */
@Composable
fun Item(
    title: String, supporting: (@Composable () -> Unit)? = null, leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null, onClick: (() -> Unit)? = null,
) = ListItem(
    headlineContent = { Text(title, maxLines = 1) },
    supportingContent = supporting, leadingContent = leading, trailingContent = trailing,
    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    modifier = if (onClick != null) Modifier.clickableRow(onClick) else Modifier,
)

fun Modifier.clickableRow(onClick: () -> Unit) = this.clickable(onClick = onClick)

@Composable
fun DateBadge(d: LocalDate) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(40.dp)) {
        Text("%02d".format(d.dayOfMonth), style = MaterialTheme.typography.titleMedium)
        Text(monthShort(d.toString().take(7)).take(3).lowercase(), style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun SummaryScreen(month: String, onShift: (Int) -> Unit, modifier: Modifier, openCard: (Long, String) -> Unit) {
    val actions = LocalActions.current
    val s = rememberData(month) { it.summary(month) }
    val accounts = rememberData { it.accounts() }.orEmpty().filter { !it.archived }

    LazyColumn(
        modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { MonthBar(month, onShift) } }
        if (s == null) return@LazyColumn
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Kpi("Receitas", s.incomeTotal, "Recebido ${money(s.incomeReceived)}", Positive, Modifier.weight(1f))
                Kpi("Despesas", s.expenseTotal, "Pago ${money(s.expensePaid)}", Negative, Modifier.weight(1f))
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Kpi("Saldo previsto", s.balanceForecast, "Realizado ${money(s.balanceRealized)}",
                    if (s.balanceForecast < 0) Negative else Color.Unspecified, Modifier.weight(1f))
                Kpi("Saldo em contas", s.accountsBalance, "Hoje", modifier = Modifier.weight(1f))
            }
        }
        item {
            val invoices = s.invoices.filter { !it.paid && it.total > 0 }
            SectionCard("Pendências do mês") {
                if (s.pending.isEmpty() && invoices.isEmpty()) Text("Tudo pago neste mês 🎉", Modifier.padding(vertical = 12.dp))
                val rows = s.pending.map { it.date to it } + invoices.map { it.dueDate to it }
                rows.sortedBy { it.first }.forEach { (date, x) ->
                    when (x) {
                        is app.financas.data.Tx -> Item(
                            x.description, leading = { DateBadge(date) },
                            supporting = {
                                if (x.kind == "income") Tag("a receber", Positive)
                                else Tag(dueLabel(java.time.temporal.ChronoUnit.DAYS.between(LocalDate.now(), date).toInt()),
                                    if (date < LocalDate.now()) Negative else MaterialTheme.colorScheme.onSurfaceVariant)
                            },
                            trailing = {
                                Column(horizontalAlignment = Alignment.End) {
                                    Text(money(x.amount), color = if (x.kind == "income") Positive else Color.Unspecified)
                                    FilledTonalButton({ actions.open(Sheet.Pay(x)) }, contentPadding = PaddingValues(horizontal = 12.dp)) {
                                        Text(if (x.kind == "income") "Receber" else "Pagar")
                                    }
                                }
                            },
                        )
                        is app.financas.data.Invoice -> Item(
                            "Fatura ${x.cardName}", leading = { DateBadge(date) },
                            supporting = { Tag("💳 ${INVOICE_STATUS[x.status]}") },
                            trailing = {
                                Column(horizontalAlignment = Alignment.End) {
                                    Text(money(x.total))
                                    FilledTonalButton({ actions.open(Sheet.PayInvoice(x)) }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text("Pagar") }
                                }
                            },
                            onClick = { openCard(x.cardId, x.month) },
                        )
                    }
                }
            }
        }
        item {
            val total = s.byCategory.sumOf { it.total }.coerceAtLeast(1)
            val max = s.byCategory.maxOfOrNull { it.total }?.coerceAtLeast(1) ?: 1
            SectionCard("Gastos por categoria") {
                if (s.byCategory.isEmpty()) Text("Nenhum gasto neste mês", Modifier.padding(vertical = 12.dp))
                s.byCategory.forEach { c ->
                    Column(Modifier.padding(vertical = 6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(10.dp).background(hexColor(c.color), CircleShape))
                            Text(c.name, Modifier.weight(1f).padding(start = 8.dp), maxLines = 1)
                            Text("${money(c.total)}  ${c.total * 100 / total}%", style = MaterialTheme.typography.bodyMedium)
                        }
                        Spacer(Modifier.height(4.dp))
                        LinearProgressIndicator(
                            progress = { c.total.toFloat() / max }, color = hexColor(c.color),
                            modifier = Modifier.fillMaxWidth(), drawStopIndicator = {},
                        )
                    }
                }
            }
        }
        if (s.invoices.isNotEmpty()) item {
            SectionCard("Faturas que vencem no mês") {
                s.invoices.forEach { i ->
                    Item(i.cardName, leading = { Box(Modifier.size(12.dp).background(hexColor(i.color), CircleShape)) },
                        supporting = { Text("vence ${dm(i.dueDate)} · ${INVOICE_STATUS[i.status]}") },
                        trailing = { Text(money(i.total)) }, onClick = { openCard(i.cardId, i.month) })
                }
            }
        }
        item {
            SectionCard("Contas") {
                accounts.forEach { a ->
                    Item(a.name, leading = { Box(Modifier.size(12.dp).background(hexColor(a.color), CircleShape)) },
                        supporting = { Text(ACCOUNT_TYPES[a.type] ?: "") },
                        trailing = { Text(money(a.balance), color = if (a.balance < 0) Negative else Color.Unspecified) })
                }
            }
        }
    }
}
