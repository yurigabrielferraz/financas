@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package app.financas.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.financas.data.Account
import app.financas.data.AccountInput
import app.financas.data.Card as CreditCard
import app.financas.data.CardInput
import app.financas.data.Category
import app.financas.data.CategoryInput
import app.financas.data.Recurrence
import app.financas.data.RecurrenceInput
import app.financas.data.Store
import app.financas.notify.Notifier
import app.financas.store
import kotlinx.coroutines.launch
import java.time.LocalDate

// ================================================================== contas fixas

@Composable
fun RecurrencesScreen(modifier: Modifier) {
    val actions = LocalActions.current
    val recs = rememberData { it.recurrences() } ?: return
    val factor = mapOf("monthly" to 1.0, "weekly" to 52.0 / 12, "yearly" to 1.0 / 12)
    fun monthly(kind: String) = recs.filter { it.active && it.kind == kind }.sumOf { it.amount * factor.getValue(it.frequency) }.toLong()
    val exp = monthly("expense")
    val inc = monthly("income")

    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Kpi("Fixas / mês", exp, color = Negative, modifier = Modifier.weight(1f))
                Kpi("Receitas / mês", inc, color = Positive, modifier = Modifier.weight(1f))
            }
        }
        item { Kpi("Sobra após fixos", inc - exp, color = if (inc < exp) Negative else Color.Unspecified, modifier = Modifier.fillMaxWidth()) }
        if (recs.isEmpty()) item {
            Text("Cadastre aluguel, luz, internet, assinaturas, boletos, salário… Eles aparecem sozinhos todo mês, com lembrete antes do vencimento.")
        }
        listOf("Despesas" to recs.filter { it.active && it.kind == "expense" }, "Receitas" to recs.filter { it.active && it.kind == "income" },
            "Inativas" to recs.filter { !it.active }).filter { it.second.isNotEmpty() }.forEach { (title, list) ->
            item(key = title) {
                SectionCard(title) { list.forEach { r -> RecurrenceRow(r) { actions.open(Sheet.RecurrenceForm(r)) } } }
            }
        }
    }
}

@Composable
private fun RecurrenceRow(r: Recurrence, onClick: () -> Unit) {
    val whenText = when (r.frequency) {
        "weekly" -> "semanal"
        "yearly" -> "anual · ${r.day ?: r.startDate.dayOfMonth}/${"%02d".format(r.startDate.monthValue)}"
        else -> "todo dia ${r.day ?: r.startDate.dayOfMonth}"
    }
    val cur = r.current
    Item(
        r.description, leading = { Letter(r.categoryName ?: r.description, r.categoryColor) },
        supporting = {
            Column {
                Text("${BILL_TYPES[r.billType]} · $whenText · ${r.cardName?.let { "💳 $it" } ?: r.accountName ?: "sem conta"}", maxLines = 1)
                when {
                    !r.active -> Tag("inativa")
                    cur?.cardId != null -> Tag("💳 na fatura")
                    cur != null && cur.paid -> Tag("pago este mês", Positive)
                    cur != null -> Tag(dueLabel(java.time.temporal.ChronoUnit.DAYS.between(LocalDate.now(), cur.date).toInt()))
                    r.nextDate != null -> Tag("próxima ${dm(r.nextDate)}")
                }
            }
        },
        trailing = { Text(money(r.amount), color = if (r.kind == "income") Positive else Color.Unspecified) },
        onClick = onClick,
    )
}

@Composable
fun RecurrenceFormSheet(rec: Recurrence?, onClose: () -> Unit) {
    val actions = LocalActions.current
    val categories = rememberData { it.categories() }.orEmpty()
    val accounts = rememberData { it.accounts() }.orEmpty()
    val cards = rememberData { it.cards() }.orEmpty()
    var kind by remember { mutableStateOf(rec?.kind ?: "expense") }
    var description by remember { mutableStateOf(rec?.description ?: "") }
    var amount by remember { mutableStateOf(centsInput(rec?.amount)) }
    var billType by remember { mutableStateOf(rec?.billType ?: "fixa") }
    var nature by remember { mutableStateOf(rec?.nature ?: if ((rec?.kind ?: "expense") == "expense") "bill" else null) }
    var frequency by remember { mutableStateOf(rec?.frequency ?: "monthly") }
    var day by remember { mutableStateOf((rec?.day ?: LocalDate.now().dayOfMonth).toString()) }
    var categoryId by remember { mutableStateOf(rec?.categoryId) }
    var source by remember { mutableStateOf(rec?.cardId?.let { "c:$it" } ?: rec?.accountId?.let { "a:$it" } ?: "auto") }
    if (source == "auto" && accounts.isNotEmpty()) source = accounts.firstOrNull { !it.archived }?.let { "a:${it.id}" } ?: ""
    var start by remember { mutableStateOf(rec?.startDate ?: LocalDate.now()) }
    var end by remember { mutableStateOf(rec?.endDate) }
    var reminder by remember { mutableStateOf(rec?.reminderDays?.toString() ?: "") }
    var active by remember { mutableStateOf(rec?.active ?: true) }
    var notes by remember { mutableStateOf(rec?.notes ?: "") }
    var confirmDelete by remember { mutableStateOf(false) }

    ModalBottomSheet(onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier.padding(horizontal = 16.dp).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(if (rec != null) "Editar conta fixa" else "Nova conta fixa / recorrente", style = MaterialTheme.typography.titleLarge)
            Segmented(listOf("expense" to "Despesa", "income" to "Receita"), kind, {
                kind = it; categoryId = null; nature = if (it == "expense") "bill" else null
            })
            OutlinedTextField(description, { description = it }, Modifier.fillMaxWidth(), label = { Text("Descrição") },
                placeholder = { Text("Aluguel, Internet, Netflix, Salário…") }, singleLine = true)
            MoneyField("Valor (estimado, se variar)", amount, { amount = it })
            Dropdown("Tipo", BILL_TYPES.toList(), billType, { billType = it })
            Dropdown("Classificação", natures(kind), nature, { nature = it })
            Dropdown("Frequência", FREQUENCIES.toList(), frequency, { frequency = it })
            if (frequency != "weekly") NumberField("Dia do vencimento", day, { day = it })
            Dropdown("Categoria", listOf<Pair<Long?, String>>(null to "Sem categoria") +
                categories.filter { it.kind == kind }.map { it.id to it.name }, categoryId, { categoryId = it })
            Dropdown("Conta / cartão",
                accounts.filter { !it.archived || "a:${it.id}" == source }.map { "a:${it.id}" to it.name } +
                    cards.filter { !it.archived || "c:${it.id}" == source }.map { "c:${it.id}" to "💳 ${it.name}" } +
                    listOf("" to "— sem conta —"), source, { source = it })
            DateField("Começa em", start, { it?.let { d -> start = d } })
            DateField("Termina em (opcional)", end, { end = it }, clearable = true)
            NumberField("Lembrar quantos dias antes", reminder, { reminder = it }, placeholder = "padrão")
            Row(verticalAlignment = Alignment.CenterVertically) { Switch(active, { active = it }); Spacer(Modifier.size(8.dp)); Text("Ativa") }
            OutlinedTextField(notes, { notes = it }, Modifier.fillMaxWidth(), label = { Text("Observações") })
            Text("Os lançamentos são criados automaticamente a cada período. Ao editar, os meses futuros ainda não pagos são atualizados.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row {
                if (rec != null) OutlinedButton({ confirmDelete = true }) { Text("Excluir", color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.weight(1f))
                Button({
                    val cents = parseMoney(amount)
                    if (cents == null || description.isBlank()) return@Button actions.message("Preencha descrição e valor")
                    val input = RecurrenceInput(
                        description.trim(), kind, billType, cents, categoryId,
                        source.takeIf { it.startsWith("a:") }?.drop(2)?.toLong(), source.takeIf { it.startsWith("c:") }?.drop(2)?.toLong(),
                        frequency, if (frequency == "weekly") null else day.toIntOrNull()?.coerceIn(1, 31), start, end,
                        reminder.toIntOrNull(), active, notes.ifBlank { null }, nature,
                    )
                    actions.run("Conta fixa salva") { it.saveRecurrence(rec?.id, input) }
                    onClose()
                }) { Text("Salvar") }
            }
        }
    }
    if (confirmDelete && rec != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Excluir conta fixa") },
            text = { Text("Excluir “${rec.description}”? Os lançamentos futuros não pagos serão removidos; o histórico pago fica.") },
            confirmButton = {
                TextButton({ actions.run("Conta fixa excluída") { it.deleteRecurrence(rec.id) }; confirmDelete = false; onClose() }) {
                    Text("Excluir", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancelar") } },
        )
    }
}

// ================================================================== cartões

@Composable
fun CardsScreen(modifier: Modifier, onOpen: (Long) -> Unit) {
    val cards = rememberData { it.cards() } ?: return
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (cards.isEmpty()) item { Text("Cadastre seus cartões no + para acompanhar faturas, parcelas e limite.") }
        items(cards, key = { it.id }) { c -> CardTile(c) { onOpen(c.id) } }
    }
}

@Composable
private fun CardTile(c: CreditCard, onClick: () -> Unit) {
    val inv = c.currentInvoice
    Card(
        Modifier.fillMaxWidth().alpha(if (c.archived) .55f else 1f).clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Box(Modifier.fillMaxWidth().height(5.dp).background(hexColor(c.color)))
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(c.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Tag(INVOICE_STATUS[inv.status] ?: inv.status)
            }
            Text("Fatura de ${monthLabel(inv.month)}", style = MaterialTheme.typography.bodySmall)
            Text(money(inv.total), style = MaterialTheme.typography.headlineSmall)
            Text("fecha ${dm(inv.closingDate)} · vence ${dm(inv.dueDate)}", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (c.creditLimit > 0) {
                LinearProgressIndicator(progress = { (c.usedLimit.toFloat() / c.creditLimit).coerceIn(0f, 1f) }, color = hexColor(c.color),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp), drawStopIndicator = {})
                Row {
                    Text("Usado ${money(c.usedLimit)}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    Text("Disponível ${money(c.availableLimit)}", style = MaterialTheme.typography.bodySmall)
                }
            }
            if (c.archived) Tag("arquivado")
        }
    }
}

@Composable
fun CardDetailScreen(cardId: Long, modifier: Modifier) {
    val actions = LocalActions.current
    var month by remember(cardId) { mutableStateOf(cardMonth[cardId]) }
    val card = rememberData(cardId) { r -> r.cards().firstOrNull { it.id == cardId } } ?: return
    val m = month ?: card.currentInvoice.month
    val inv = rememberData(cardId, m) { it.invoice(cardId, m) } ?: return
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(12.dp).background(hexColor(card.color), CircleShape))
                Text(card.name, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 8.dp).weight(1f))
                TextButton({ actions.open(Sheet.CardForm(card)) }) { Text("Editar") }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                MonthBar(m, { val n = app.financas.data.Dates.shiftYm(m, it); month = n; cardMonth[cardId] = n })
            }
        }
        item {
            SectionCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Fatura de ${monthLabel(m)}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    Tag(INVOICE_STATUS[inv.status] ?: "")
                }
                Text(money(inv.total), style = MaterialTheme.typography.headlineMedium)
                Text("Fecha em ${dmy(inv.closingDate)} · vence em ${dmy(inv.dueDate)}", style = MaterialTheme.typography.bodySmall)
                if (inv.paid) Text("✓ Paga em ${inv.paidDate?.let { dmy(LocalDate.parse(it)) }} — ${money(inv.paidAmount ?: 0)}", style = MaterialTheme.typography.bodySmall)
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (inv.paid) OutlinedButton({ actions.run("Pagamento desfeito") { it.unpayInvoice(cardId, m) } }) { Text("Desfazer pagamento") }
                    else FilledTonalButton({ actions.open(Sheet.PayInvoice(inv)) }, enabled = inv.total > 0) { Text("Pagar fatura") }
                }
                if (card.creditLimit > 0) {
                    Text("Limite: usado ${money(card.usedLimit)} · disponível ${money(card.availableLimit)}",
                        style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                }
            }
        }
        item {
            SectionCard("Compras da fatura (${inv.items.size})") {
                if (inv.items.isEmpty()) Text("Nenhuma compra nesta fatura", Modifier.padding(vertical = 12.dp))
                inv.items.forEach { t -> TxRow(t) { actions.open(Sheet.TxForm(t)) } }
            }
        }
    }
}

/** onClose(true) quando o cartão foi excluído/arquivado. */
@Composable
fun CardFormSheet(card: CreditCard?, onClose: (Boolean) -> Unit) {
    val actions = LocalActions.current
    val accounts = rememberData { it.accounts() }.orEmpty().filter { !it.archived }
    var name by remember { mutableStateOf(card?.name ?: "") }
    var limit by remember { mutableStateOf(centsInput(card?.creditLimit?.takeIf { it > 0 })) }
    var closing by remember { mutableStateOf((card?.closingDay ?: 1).toString()) }
    var due by remember { mutableStateOf((card?.dueDay ?: 10).toString()) }
    var color by remember { mutableStateOf(card?.color ?: "#8b5cf6") }
    var accountId by remember { mutableStateOf(card?.accountId) }
    if (accountId == null && card == null && accounts.isNotEmpty()) accountId = accounts.first().id
    var reminder by remember { mutableStateOf(card?.reminderDays?.toString() ?: "") }
    ModalBottomSheet({ onClose(false) }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier.padding(horizontal = 16.dp).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(if (card != null) "Editar cartão" else "Novo cartão de crédito", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Nome") }, singleLine = true)
            MoneyField("Limite", limit, { limit = it })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NumberField("Dia do fechamento", closing, { closing = it }, Modifier.weight(1f))
                NumberField("Dia do vencimento", due, { due = it }, Modifier.weight(1f))
            }
            Text("Compras feitas a partir do dia do fechamento entram na fatura seguinte.", style = MaterialTheme.typography.bodySmall)
            ColorPicker(color) { color = it }
            Dropdown("Conta que paga a fatura", accounts.map<Account, Pair<Long?, String>> { it.id to it.name }, accountId, { accountId = it })
            NumberField("Lembrar quantos dias antes", reminder, { reminder = it }, placeholder = "padrão")
            Row {
                if (card != null) OutlinedButton({
                    if (card.archived) actions.run("Cartão reativado") { it.saveCard(card.id, input(card, false)) }
                    else actions.run("Cartão removido") { it.deleteCard(card.id) }
                    onClose(!card.archived)
                }) { Text(if (card.archived) "Reativar" else "Excluir", color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.weight(1f))
                Button({
                    val c = closing.toIntOrNull()?.coerceIn(1, 31)
                    val d = due.toIntOrNull()?.coerceIn(1, 31)
                    if (name.isBlank() || c == null || d == null) return@Button actions.message("Preencha nome, fechamento e vencimento")
                    val input = CardInput(name.trim(), parseMoney(limit) ?: 0, c, d, color, accountId, reminder.toIntOrNull(), card?.archived ?: false)
                    actions.run("Cartão salvo") { it.saveCard(card?.id, input) }
                    onClose(false)
                }) { Text("Salvar") }
            }
        }
    }
}

private fun input(c: CreditCard, archived: Boolean) =
    CardInput(c.name, c.creditLimit, c.closingDay, c.dueDay, c.color, c.accountId, c.reminderDays, archived)

// ================================================================== ajustes

@Composable
fun SettingsScreen(modifier: Modifier) {
    val ctx = LocalContext.current
    val store = ctx.store
    val actions = LocalActions.current
    val scope = rememberCoroutineScope()
    val status by store.status.collectAsState()
    val settings = rememberData { it.settings() }
    val accounts = rememberData { it.accounts() }.orEmpty()
    val categories = rememberData { it.categories() }.orEmpty()
    val fileName = rememberData { store.fileName() }
    val (openFile, createFile) = rememberFilePickers()
    var editAccount by remember { mutableStateOf<Account?>(null) }
    var newAccount by remember { mutableStateOf(false) }
    var editCategory by remember { mutableStateOf<Category?>(null) }
    var newCategory by remember { mutableStateOf(false) }
    var days by remember(settings) { mutableStateOf((settings?.get("reminder_days_default") as? Number)?.toString() ?: "3") }
    var hour by remember(settings) { mutableStateOf((settings?.get("notify_hour") as? Number)?.toInt() ?: 8) }
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SectionCard("Arquivo de dados (Google Drive)") {
                Text(fileName ?: "—", style = MaterialTheme.typography.bodyLarge)
                Text(
                    when (val s = status) {
                        is Store.Status.Ok -> "Sincronizado às ${s.at.withNano(0)}"
                        is Store.Status.Syncing -> "Sincronizando…"
                        is Store.Status.Offline -> "Sem conexão com o Drive — as alterações ficam no celular e são enviadas depois"
                        is Store.Status.Error -> s.message
                        is Store.Status.Conflict -> "Conflito: escolha qual versão manter"
                        else -> ""
                    },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    FilledTonalButton({ scope.launch { store.sync() } }) { Text("Sincronizar agora") }
                    OutlinedButton(openFile) { Text("Trocar arquivo") }
                    OutlinedButton(createFile) { Text("Criar novo") }
                }
            }
        }
        item {
            SectionCard("Lembretes") {
                NumberField("Avisar quantos dias antes (padrão)", days, { days = it })
                Spacer(Modifier.height(8.dp))
                Dropdown("Horário do aviso diário", (0..23).map { it to "%02d:00".format(it) }, hour, { hour = it })
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    Button({
                        val h = hour
                        actions.run("Lembretes salvos") { it.setSettings(mapOf("reminder_days_default" to (days.toLongOrNull() ?: 3L), "notify_hour" to h.toLong())) }
                        Notifier.schedule(ctx, h)
                    }) { Text("Salvar") }
                    if (Build.VERSION.SDK_INT >= 33 && !Notifier.canNotify(ctx)) {
                        OutlinedButton({ askPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("Permitir notificações") }
                    }
                    OutlinedButton({ Notifier.runNow(ctx); actions.message("Verificando contas…") }) { Text("Testar agora") }
                }
            }
        }
        item {
            SectionCard("Contas", action = { TextButton({ newAccount = true }) { Text("+ Nova") } }) {
                accounts.forEach { a ->
                    Item(a.name, leading = { Box(Modifier.size(12.dp).background(hexColor(a.color), CircleShape)) },
                        supporting = { Text((ACCOUNT_TYPES[a.type] ?: "") + if (a.archived) " · arquivada" else "") },
                        trailing = { Text(money(a.balance), color = if (a.balance < 0) Negative else Color.Unspecified) },
                        onClick = { editAccount = a })
                }
            }
        }
        item {
            SectionCard("Categorias", action = { TextButton({ newCategory = true }) { Text("+ Nova") } }) {
                listOf("expense" to "Despesas", "income" to "Receitas").forEach { (kind, label) ->
                    Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 8.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        categories.filter { it.kind == kind }.forEach { c ->
                            AssistChip({ editCategory = c }, { Text(c.name) },
                                leadingIcon = { Box(Modifier.size(10.dp).background(hexColor(c.color), CircleShape)) })
                        }
                    }
                }
            }
        }
    }

    if (newAccount || editAccount != null) AccountDialog(editAccount) { newAccount = false; editAccount = null }
    if (newCategory || editCategory != null) CategoryDialog(editCategory) { newCategory = false; editCategory = null }
}

@Composable
private fun AccountDialog(a: Account?, onClose: () -> Unit) {
    val actions = LocalActions.current
    var name by remember { mutableStateOf(a?.name ?: "") }
    var type by remember { mutableStateOf(a?.type ?: "checking") }
    var initial by remember { mutableStateOf(centsInput(a?.initialBalance ?: 0)) }
    var color by remember { mutableStateOf(a?.color ?: "#4f46e5") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (a != null) "Editar conta" else "Nova conta") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Nome") }, singleLine = true)
                Dropdown("Tipo", ACCOUNT_TYPES.toList(), type, { type = it })
                MoneyField("Saldo inicial", initial, { initial = it })
                ColorPicker(color) { color = it }
            }
        },
        confirmButton = {
            TextButton({
                if (name.isBlank()) return@TextButton actions.message("Informe o nome")
                actions.run("Conta salva") { it.saveAccount(a?.id, AccountInput(name.trim(), type, parseMoney(initial) ?: 0, color)) }
                onClose()
            }) { Text("Salvar") }
        },
        dismissButton = {
            Row {
                if (a != null) TextButton({ actions.run("Conta removida") { it.deleteAccount(a.id) }; onClose() }) {
                    Text("Excluir", color = MaterialTheme.colorScheme.error)
                }
                TextButton(onClose) { Text("Cancelar") }
            }
        },
    )
}

@Composable
private fun CategoryDialog(c: Category?, onClose: () -> Unit) {
    val actions = LocalActions.current
    var name by remember { mutableStateOf(c?.name ?: "") }
    var kind by remember { mutableStateOf(c?.kind ?: "expense") }
    var color by remember { mutableStateOf(c?.color ?: "#64748b") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (c != null) "Editar categoria" else "Nova categoria") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Nome") }, singleLine = true)
                Segmented(listOf("expense" to "Despesa", "income" to "Receita"), kind, { kind = it })
                ColorPicker(color) { color = it }
            }
        },
        confirmButton = {
            TextButton({
                if (name.isBlank()) return@TextButton actions.message("Informe o nome")
                actions.run("Categoria salva") { it.saveCategory(c?.id, CategoryInput(name.trim(), kind, color)) }
                onClose()
            }) { Text("Salvar") }
        },
        dismissButton = {
            Row {
                if (c != null) TextButton({ actions.run("Categoria excluída") { it.deleteCategory(c.id) }; onClose() }) {
                    Text("Excluir", color = MaterialTheme.colorScheme.error)
                }
                TextButton(onClose) { Text("Cancelar") }
            }
        },
    )
}
