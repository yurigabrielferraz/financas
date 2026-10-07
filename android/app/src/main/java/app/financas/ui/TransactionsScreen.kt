@file:OptIn(ExperimentalMaterial3Api::class)

package app.financas.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.financas.data.Dates
import app.financas.data.Tx
import app.financas.data.TxInput
import java.time.DayOfWeek
import java.time.LocalDate

@Composable
fun TransactionsScreen(month: String, onShift: (Int) -> Unit, modifier: Modifier) {
    var grid by rememberSaveable { mutableStateOf(true) }
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Segmented(listOf(true to "Grade", false to "Lista"), grid, { grid = it }, Modifier.width(170.dp))
            Spacer(Modifier.weight(1f))
            MonthBar(month, onShift, monthShort(month))
        }
        if (grid) GridView(month) else TxList(month)
    }
}

// ------------------------------------------------------------------ lista

@Composable
private fun TxList(month: String) {
    val actions = LocalActions.current
    val txs = rememberData(month) { it.transactions(month) } ?: return
    val income = txs.filter { it.kind == "income" }.sumOf { it.amount }
    val expense = txs.filter { it.kind == "expense" }.sumOf { it.amount }
    LazyColumn(contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Kpi("Entradas", income, color = Positive, modifier = Modifier.weight(1f))
                Kpi("Saídas", expense, color = Negative, modifier = Modifier.weight(1f))
            }
        }
        if (txs.isEmpty()) item { Text("Nenhum lançamento. Toque em + para adicionar.", Modifier.padding(24.dp)) }
        txs.groupBy { it.date }.forEach { (date, list) ->
            item(key = date.toString()) {
                Text(dayHeader(date), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
            }
            items(list, key = { it.id }) { t -> TxRow(t) { actions.open(Sheet.TxForm(t)) } }
        }
    }
}

@Composable
fun TxRow(t: Tx, onClick: () -> Unit) {
    val actions = LocalActions.current
    Item(
        t.description, leading = { Letter(t.categoryName ?: t.description, t.categoryColor) },
        supporting = {
            val parts = listOfNotNull(
                t.categoryName ?: "sem categoria",
                t.cardName?.let { "💳 $it · fatura ${monthShort(t.invoiceMonth!!)}" } ?: t.accountName,
                t.installmentTotal?.let { "${t.installmentNo}/$it" },
                t.recurrenceId?.let { "↻ " + (BILL_TYPES[t.billType] ?: "fixa") },
            )
            Text(parts.joinToString(" · "), maxLines = 1)
        },
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text((if (t.kind == "income") "+ " else "− ") + money(t.amount),
                    color = if (t.kind == "income") Positive else Color.Unspecified, modifier = Modifier.padding(end = 8.dp))
                PaidToggle(t.paid, if (t.cardId != null) null else ({ actions.run { r -> r.payTransaction(t.id, !t.paid) } }))
            }
        },
        onClick = onClick,
    )
}

// ------------------------------------------------------------------ grade de saldos

private data class Col(val key: String, val label: String, val letter: String, val color: Color)

private val COLS = listOf(
    Col("income", "entradas", "↙", Color(0xFF22C55E)), Col("bills", "saídas", "↗", Color(0xFFEF4444)),
    Col("daily", "diários", "D", Color(0xFFEC4899)), Col("savings", "economias", "E", Color(0xFF84CC16)),
    Col("card", "cartão", "C", Color(0xFF8B5CF6)),
)
private val DAY_W = 44.dp
private val COL_W = 108.dp
private val BAL_W = 120.dp
private val ROW_H = 44.dp

@Composable
private fun ColIcon(c: Col, dim: Boolean = false) {
    Box(Modifier.size(18.dp).alpha(if (dim) .35f else 1f).background(c.color, CircleShape), contentAlignment = Alignment.Center) {
        Text(c.letter, color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Cell(width: Dp, modifier: Modifier = Modifier, content: @Composable () -> Unit) =
    Box(modifier.width(width).height(ROW_H).padding(horizontal = 8.dp), contentAlignment = Alignment.CenterEnd) { content() }

@Composable
private fun GridView(month: String) {
    val actions = LocalActions.current
    val gm = rememberData(month) { it.grid(month, 1).second.first() } ?: return
    val today = LocalDate.now()
    val vScroll = rememberScrollState()
    val rowPx = with(LocalDensity.current) { ROW_H.roundToPx() }
    LaunchedEffect(month) { if (Dates.ym(today) == month) vScroll.scrollTo(rowPx * (today.dayOfMonth - 2).coerceAtLeast(0)) }
    val outline = MaterialTheme.colorScheme.outlineVariant

    // rolagem horizontal única (cabeçalho, dias e totais andam juntos); só os dias rolam na vertical
    Row(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
        Column(Modifier.fillMaxHeight()) {
            Row(Modifier.background(MaterialTheme.colorScheme.surfaceContainer)) {
                Cell(DAY_W) { Text("dia", style = MaterialTheme.typography.labelMedium) }
                COLS.forEach { c ->
                    Cell(COL_W) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ColIcon(c); Spacer(Modifier.width(6.dp)); Text(c.label, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
                Cell(BAL_W) { Text("saldo", style = MaterialTheme.typography.labelMedium) }
            }
            Column(Modifier.weight(1f).verticalScroll(vScroll)) {
                gm.days.forEach { d ->
                    val weekend = d.date.dayOfWeek == DayOfWeek.SATURDAY || d.date.dayOfWeek == DayOfWeek.SUNDAY
                    Row(Modifier.background(if (d.date == today) MaterialTheme.colorScheme.primary.copy(alpha = .10f) else Color.Transparent)) {
                        Cell(DAY_W, Modifier.background(if (weekend) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent)) {
                            Text("${d.date.dayOfMonth}", fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                                color = if (d.date == today) MaterialTheme.colorScheme.primary else Color.Unspecified)
                        }
                        COLS.forEach { c ->
                            val v = d.value(c.key)
                            Cell(COL_W, Modifier.clickable { actions.open(Sheet.Cell(c.key, d.date)) }) {
                                Text(money(v), Modifier.alpha(if (v == 0L) .35f else 1f), style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                        val neg = d.balance < 0
                        Cell(BAL_W, Modifier.background((if (neg) Negative else Positive).copy(alpha = .14f))) {
                            Text(money(d.balance), color = if (neg) Negative else Positive, fontWeight = FontWeight.SemiBold,
                                style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    HorizontalDivider(Modifier.width(DAY_W + COL_W * COLS.size + BAL_W), color = outline)
                }
                Spacer(Modifier.height(88.dp)) // espaço do botão +
            }
            Row(Modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
                Cell(DAY_W) {}
                COLS.forEach { c ->
                    val v = gm.totals[c.key] ?: 0
                    Cell(COL_W) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ColIcon(c, v == 0L); Spacer(Modifier.width(6.dp)); Text(money(v), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                Cell(BAL_W) { Text(money(gm.endBalance), fontWeight = FontWeight.Bold, color = if (gm.endBalance < 0) Negative else Positive) }
            }
        }
    }
}

/** Itens de uma célula da grade + botão para adicionar naquele dia. */
@Composable
fun CellSheet(column: String, date: LocalDate, onClose: () -> Unit) {
    val actions = LocalActions.current
    val month = Dates.ym(date)
    val col = COLS.first { it.key == column }
    val txs = rememberData(month, column, date) { r -> r.transactions(month).filter { it.date == date && it.gridColumn == column } }
    val invoices = rememberData(month, date) { r -> r.summary(month).invoices.filter { it.dueDate == date } }
    val firstCard = rememberData { r -> r.cards().firstOrNull { !it.archived }?.id }
    val defaults = when (column) {
        "income" -> newTx("income", date, nature = null)
        "bills" -> newTx(date = date, nature = "bill")
        "savings" -> newTx(date = date, nature = "saving")
        "card" -> newTx(date = date, cardId = firstCard, nature = null)
        else -> newTx(date = date)
    }
    ModalBottomSheet(onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.padding(horizontal = 16.dp).navigationBarsPadding().padding(bottom = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ColIcon(col); Spacer(Modifier.width(8.dp))
                Text("${col.label.replaceFirstChar(Char::uppercase)} — ${dayHeader(date)}", style = MaterialTheme.typography.titleLarge)
            }
            if (column == "card") {
                invoices.orEmpty().forEach { i ->
                    Item("Fatura ${i.cardName}", supporting = { Text(INVOICE_STATUS[i.status] ?: "") },
                        trailing = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(money(i.total))
                                if (!i.paid) TextButton({ actions.open(Sheet.PayInvoice(i)) }) { Text("Pagar") }
                            }
                        })
                }
                if (invoices.orEmpty().isEmpty()) Text("Nenhuma fatura vence neste dia.", Modifier.padding(vertical = 12.dp))
            } else {
                txs.orEmpty().forEach { t -> TxRow(t) { actions.open(Sheet.TxForm(t)) } }
                if (txs.orEmpty().isEmpty()) Text("Nada lançado neste dia.", Modifier.padding(vertical = 12.dp))
            }
            Button({ actions.open(Sheet.TxForm(defaults = defaults)) }, Modifier.fillMaxWidth().padding(top = 8.dp),
                enabled = column != "card" || firstCard != null) {
                Text(if (column == "card") "+ Compra no cartão" else "+ Adicionar")
            }
        }
    }
}

// ------------------------------------------------------------------ formulário de lançamento

@Composable
fun TxFormSheet(tx: Tx?, defaults: TxInput?, onClose: () -> Unit) {
    val actions = LocalActions.current
    val isEdit = tx != null
    val init = tx?.let {
        TxInput(it.kind, it.description, it.amount, it.date, it.categoryId, it.accountId, it.cardId, it.paid,
            it.reminderDays, it.notes, it.nature ?: if (it.kind == "expense") "bill" else null)
    } ?: defaults ?: newTx()
    val categories = rememberData { it.categories() }.orEmpty()
    val accounts = rememberData { it.accounts() }.orEmpty()
    val cards = rememberData { it.cards() }.orEmpty()

    var kind by remember { mutableStateOf(init.kind) }
    var amount by remember { mutableStateOf(centsInput(init.amount.takeIf { it > 0 })) }
    var description by remember { mutableStateOf(init.description) }
    var date by remember { mutableStateOf(init.date) }
    var categoryId by remember { mutableStateOf(init.categoryId) }
    var source by remember {
        mutableStateOf(init.cardId?.let { "c:$it" } ?: init.accountId?.let { "a:$it" } ?: if (isEdit) "" else "auto")
    }
    if (source == "auto" && accounts.isNotEmpty()) source = accounts.firstOrNull { !it.archived }?.let { "a:${it.id}" } ?: ""
    var nature by remember { mutableStateOf(init.nature) }
    var installments by remember { mutableStateOf("1") }
    var perInstallment by remember { mutableStateOf(false) }
    var paid by remember { mutableStateOf(if (isEdit) init.paid else init.date <= LocalDate.now()) }
    var reminder by remember { mutableStateOf(init.reminderDays?.toString() ?: "") }
    var notes by remember { mutableStateOf(init.notes ?: "") }
    var confirmDelete by remember { mutableStateOf(false) }

    val cardId = source.removePrefix("c:").toLongOrNull()?.takeIf { source.startsWith("c:") }
    val accountId = source.removePrefix("a:").toLongOrNull()?.takeIf { source.startsWith("a:") }
    val card = cards.firstOrNull { it.id == cardId }
    val n = installments.toIntOrNull()?.coerceIn(1, 72) ?: 1

    ModalBottomSheet(onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier.padding(horizontal = 16.dp).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(if (isEdit) "Editar lançamento" else "Novo lançamento", style = MaterialTheme.typography.titleLarge)
            Segmented(listOf("expense" to "Despesa", "income" to "Receita"), kind, {
                kind = it; categoryId = null; nature = if (it == "expense") "daily" else null
            })
            MoneyField(if (!isEdit && n > 1 && !perInstallment) "Valor total" else "Valor", amount, { amount = it })
            OutlinedTextField(description, { description = it }, Modifier.fillMaxWidth(), label = { Text("Descrição") }, singleLine = true)
            DateField("Data", date, { it?.let { d -> date = d } })
            Dropdown("Categoria", listOf<Pair<Long?, String>>(null to "Sem categoria") +
                categories.filter { it.kind == kind && (!it.archived || it.id == categoryId) }.map { it.id to it.name },
                categoryId, { categoryId = it })
            Dropdown("Conta / cartão",
                accounts.filter { !it.archived || "a:${it.id}" == source }.map { "a:${it.id}" to it.name } +
                    cards.filter { !it.archived || "c:${it.id}" == source }.map { "c:${it.id}" to "💳 ${it.name}" } +
                    listOf("" to "— sem conta —"),
                source, { source = it })
            if (card != null) {
                Text("💳 Entra na fatura de ${monthLabel(Dates.invoiceMonthFor(date, card.closingDay, card.dueDay))} (vence dia ${card.dueDay}).",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Dropdown("Classificação", natures(kind), nature, { nature = it })
            }
            if (!isEdit) {
                NumberField("Parcelas", installments, { installments = it })
                if (n > 1) {
                    Segmented(listOf(false to "Valor total", true to "Valor da parcela"), perInstallment, { perInstallment = it })
                    parseMoney(amount)?.let { v ->
                        val each = if (perInstallment) v else v / n
                        Text("${n}x de ${money(each)} = ${money(if (perInstallment) v * n else v)}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (card == null) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { paid = !paid }) {
                    Checkbox(paid, { paid = it }); Text(if (kind == "income") "Já recebi" else "Já foi pago")
                }
            }
            if (tx?.installmentTotal != null) Text("Parcela ${tx.installmentNo}/${tx.installmentTotal} — a edição vale só para esta parcela.", style = MaterialTheme.typography.bodySmall)
            if (tx?.recurrenceId != null) Text("↻ Gerado por uma conta fixa. Para mudar todos os meses, edite em Contas fixas.", style = MaterialTheme.typography.bodySmall)
            NumberField("Lembrar quantos dias antes", reminder, { reminder = it }, placeholder = "padrão")
            OutlinedTextField(notes, { notes = it }, Modifier.fillMaxWidth(), label = { Text("Observações") })

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (isEdit) OutlinedButton({ confirmDelete = true }) { Text("Excluir", color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.weight(1f))
                Button({
                    val cents = parseMoney(amount)
                    when {
                        cents == null || cents <= 0 -> actions.message("Informe um valor válido")
                        description.isBlank() -> actions.message("Informe uma descrição")
                        else -> {
                            val input = TxInput(kind, description.trim(), cents, date, categoryId, accountId, cardId, paid,
                                reminder.toIntOrNull(), notes.ifBlank { null }, nature, n, if (perInstallment) "installment" else "total")
                            if (isEdit) actions.run("Lançamento atualizado") { it.updateTransaction(tx!!.id, input) }
                            else actions.run(if (n > 1) "$n parcelas lançadas" else "Lançamento salvo") { it.createTransaction(input) }
                            onClose()
                        }
                    }
                }) { Text("Salvar") }
            }
        }
    }

    if (confirmDelete && tx != null) {
        fun delete(scope: String) {
            actions.run("Excluído") { it.deleteTransaction(tx.id, scope) }
            confirmDelete = false
            onClose()
        }
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Excluir lançamento") },
            text = {
                Text(when {
                    tx.installmentGroup != null -> "“${tx.description}” é a parcela ${tx.installmentNo}/${tx.installmentTotal}."
                    tx.recurrenceId != null -> "Excluir só deste mês? A conta fixa continua nos outros meses."
                    else -> "Excluir “${tx.description}”?"
                })
            },
            confirmButton = {
                if (tx.installmentGroup != null) {
                    Column(horizontalAlignment = Alignment.End) {
                        TextButton({ delete("one") }) { Text("Só esta") }
                        TextButton({ delete("future") }) { Text("Esta e as próximas") }
                        TextButton({ delete("all") }) { Text("Todas", color = MaterialTheme.colorScheme.error) }
                    }
                } else {
                    TextButton({ delete("one") }) { Text("Excluir", color = MaterialTheme.colorScheme.error) }
                }
            },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancelar") } },
        )
    }
}

// ------------------------------------------------------------------ pagamentos

@Composable
fun PayDialog(tx: Tx, onClose: () -> Unit) {
    val actions = LocalActions.current
    val accounts = rememberData { it.accounts() }.orEmpty().filter { !it.archived }
    var amount by remember { mutableStateOf(centsInput(tx.amount)) }
    var date by remember { mutableStateOf(LocalDate.now()) }
    var accountId by remember { mutableStateOf(tx.accountId) }
    if (accountId == null && accounts.isNotEmpty()) accountId = accounts.first().id
    val income = tx.kind == "income"
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (income) "Confirmar recebimento" else "Confirmar pagamento") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("${tx.description} · vencimento ${dmy(tx.date)}")
                MoneyField(if (income) "Valor recebido" else "Valor pago", amount, { amount = it })
                DateField("Data", date, { it?.let { d -> date = d } })
                Dropdown(if (income) "Recebido em" else "Pago com", accounts.map { it.id to it.name }, accountId, { accountId = it })
            }
        },
        confirmButton = {
            TextButton({
                val cents = parseMoney(amount) ?: return@TextButton actions.message("Valor inválido")
                actions.run(if (income) "Recebimento confirmado" else "Pagamento registrado") {
                    it.payTransaction(tx.id, true, date, accountId, cents)
                }
                onClose()
            }) { Text(if (income) "Recebido" else "Pago") }
        },
        dismissButton = { TextButton(onClose) { Text("Cancelar") } },
    )
}

@Composable
fun PayInvoiceDialog(inv: app.financas.data.Invoice, onClose: () -> Unit) {
    val actions = LocalActions.current
    val accounts = rememberData { it.accounts() }.orEmpty().filter { !it.archived }
    val cardAccount = rememberData(inv.cardId) { r -> r.cards().firstOrNull { it.id == inv.cardId }?.accountId }
    var amount by remember { mutableStateOf(centsInput(inv.total)) }
    var date by remember { mutableStateOf(LocalDate.now()) }
    var accountId by remember { mutableStateOf<Long?>(null) }
    if (accountId == null) accountId = cardAccount ?: accounts.firstOrNull()?.id
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Pagar fatura ${inv.cardName}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Fatura de ${monthLabel(inv.month)} · vence ${dmy(inv.dueDate)}")
                MoneyField("Valor pago", amount, { amount = it })
                DateField("Data", date, { it?.let { d -> date = d } })
                Dropdown("Pago com", accounts.map { it.id to it.name }, accountId, { accountId = it })
            }
        },
        confirmButton = {
            TextButton({
                val cents = parseMoney(amount) ?: return@TextButton actions.message("Valor inválido")
                actions.run("Fatura paga") { it.payInvoice(inv.cardId, inv.month, cents, date, accountId) }
                onClose()
            }) { Text("Registrar pagamento") }
        },
        dismissButton = { TextButton(onClose) { Text("Cancelar") } },
    )
}
