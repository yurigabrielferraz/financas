@file:OptIn(ExperimentalMaterial3Api::class)

package app.financas.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SpaceDashboard
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.SyncProblem
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.financas.data.Card
import app.financas.data.Dates
import app.financas.data.Invoice
import app.financas.data.Recurrence
import app.financas.data.Repo
import app.financas.data.Store
import app.financas.data.Tx
import app.financas.data.TxInput
import app.financas.store
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.time.LocalDate

// ------------------------------------------------------------------ estado compartilhado

/** Folhas/diálogos abertos sobre a tela atual. */
sealed interface Sheet {
    data class TxForm(val tx: Tx? = null, val defaults: TxInput? = null) : Sheet
    data class Pay(val tx: Tx) : Sheet
    data class PayInvoice(val invoice: Invoice) : Sheet
    data class RecurrenceForm(val rec: Recurrence? = null) : Sheet
    data class CardForm(val card: Card? = null) : Sheet
    data class Cell(val column: String, val date: LocalDate) : Sheet
}

class Actions(private val scope: CoroutineScope, private val store: Store, private val snack: SnackbarHostState, val open: (Sheet?) -> Unit) {
    /** Executa uma alteração no banco (e agenda o envio ao Drive). */
    fun run(done: String? = null, block: (Repo) -> Unit) {
        scope.launch {
            try {
                store.write(block)
                done?.let { snack.showSnackbar(it) }
            } catch (e: Exception) {
                snack.showSnackbar(e.message ?: "Erro")
            }
        }
    }

    fun message(text: String) { scope.launch { snack.showSnackbar(text) } }
}

val LocalActions = staticCompositionLocalOf<Actions> { error("Actions") }

/** Carrega dados do banco e recarrega a cada alteração. */
@Composable
fun <T> rememberData(vararg keys: Any?, block: (Repo) -> T): T? {
    val store = LocalContext.current.store
    val v by store.version.collectAsState()
    val state = produceState<T?>(null, v, *keys) { value = runCatching { store.read(block) }.getOrNull() }
    return state.value
}

// ------------------------------------------------------------------ raiz

@Composable
fun Root() {
    val store = LocalContext.current.store
    val uri by store.uriFlow.collectAsState()
    if (uri == null) Onboarding() else MainScaffold()
}

private fun takePermission(ctx: Context, u: Uri) = runCatching {
    ctx.contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
}

/** Seletores de arquivo do sistema (o Google Drive aparece neles). Retorna (abrir, criar). */
@Composable
fun rememberFilePickers(): Pair<() -> Unit, () -> Unit> {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val open = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u ->
        u?.let { takePermission(ctx, it); scope.launch { ctx.store.useFile(it, create = false) } }
    }
    val create = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { u ->
        u?.let { takePermission(ctx, it); scope.launch { ctx.store.useFile(it, create = true) } }
    }
    return { open.launch(arrayOf("*/*")) } to { create.launch("financas.db") }
}

@Composable
private fun Onboarding() {
    val (open, create) = rememberFilePickers()
    val status by LocalContext.current.store.status.collectAsState()
    Scaffold { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        ) {
            Text("Minhas Finanças", style = MaterialTheme.typography.headlineMedium)
            Text(
                "Os dados ficam num arquivo no seu Google Drive — o mesmo usado pela versão web. " +
                    "Escolha o arquivo existente (Meu Drive › Financas › financas.db) ou crie um novo.",
                style = MaterialTheme.typography.bodyLarge,
            )
            Button(open, Modifier.fillMaxWidth()) { Text("Abrir arquivo do Drive") }
            OutlinedButton(create, Modifier.fillMaxWidth()) { Text("Criar arquivo novo") }
            (status as? Store.Status.Error)?.let { Text(it.message, color = MaterialTheme.colorScheme.error) }
        }
    }
}

private enum class Tab(val label: String, val icon: ImageVector, val short: String = label) {
    Resumo("Resumo", Icons.Outlined.SpaceDashboard),
    Lancamentos("Lançamentos", Icons.AutoMirrored.Outlined.ReceiptLong, "Extrato"),
    Fixas("Contas fixas", Icons.Outlined.EventRepeat, "Fixas"),
    Cartoes("Cartões", Icons.Outlined.CreditCard),
    Ajustes("Ajustes", Icons.Outlined.Settings),
}

@Composable
private fun MainScaffold() {
    val store = LocalContext.current.store
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var tab by rememberSaveable { mutableStateOf(Tab.Resumo) }
    var month by rememberSaveable { mutableStateOf(Dates.ym(LocalDate.now())) }
    var cardId by rememberSaveable { mutableStateOf<Long?>(null) }
    var sheet by remember { mutableStateOf<Sheet?>(null) }
    val actions = remember { Actions(scope, store, snack) { sheet = it } }
    val status by store.status.collectAsState()

    CompositionLocalProvider(LocalActions provides actions) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(if (tab == Tab.Cartoes && cardId != null) "Fatura" else tab.label) },
                    navigationIcon = {
                        if (tab == Tab.Cartoes && cardId != null) {
                            IconButton({ cardId = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar") }
                        }
                    },
                    actions = {
                        IconButton({ scope.launch { store.sync() } }) {
                            when (val s = status) {
                                is Store.Status.Syncing -> Icon(Icons.Outlined.Sync, "Sincronizando")
                                is Store.Status.Ok -> Icon(Icons.Outlined.CloudDone, "Sincronizado às ${s.at.withNano(0)}")
                                is Store.Status.Offline, is Store.Status.Error -> Icon(Icons.Outlined.CloudOff, "Sem conexão com o Drive")
                                is Store.Status.Conflict -> Icon(Icons.Outlined.SyncProblem, "Conflito", tint = MaterialTheme.colorScheme.error)
                                else -> Icon(Icons.Outlined.Sync, "Sincronizar")
                            }
                        }
                    },
                )
            },
            bottomBar = {
                NavigationBar {
                    Tab.entries.forEach { t ->
                        NavigationBarItem(
                            selected = tab == t, onClick = { tab = t; if (t != Tab.Cartoes) cardId = null },
                            icon = { Icon(t.icon, null) }, label = { Text(t.short, maxLines = 1) },
                        )
                    }
                }
            },
            floatingActionButton = {
                val onClick: (() -> Unit)? = when (tab) {
                    Tab.Resumo, Tab.Lancamentos -> ({ sheet = Sheet.TxForm() })
                    Tab.Fixas -> ({ sheet = Sheet.RecurrenceForm() })
                    Tab.Cartoes -> ({ sheet = if (cardId != null) Sheet.TxForm(defaults = newTx(cardId = cardId)) else Sheet.CardForm() })
                    Tab.Ajustes -> null
                }
                if (onClick != null) FloatingActionButton(onClick) { Icon(Icons.Filled.Add, "Adicionar") }
            },
            snackbarHost = { SnackbarHost(snack) },
        ) { pad ->
            val m = Modifier.padding(pad)
            when (tab) {
                Tab.Resumo -> SummaryScreen(month, { month = Dates.shiftYm(month, it) }, m) { id, mo -> tab = Tab.Cartoes; cardId = id; cardMonth[id] = mo }
                Tab.Lancamentos -> TransactionsScreen(month, { month = Dates.shiftYm(month, it) }, m)
                Tab.Fixas -> RecurrencesScreen(m)
                Tab.Cartoes -> if (cardId == null) CardsScreen(m) { cardId = it } else CardDetailScreen(cardId!!, m)
                Tab.Ajustes -> SettingsScreen(m)
            }
        }

        when (val s = sheet) {
            null -> {}
            is Sheet.TxForm -> TxFormSheet(s.tx, s.defaults) { sheet = null }
            is Sheet.Pay -> PayDialog(s.tx) { sheet = null }
            is Sheet.PayInvoice -> PayInvoiceDialog(s.invoice) { sheet = null }
            is Sheet.RecurrenceForm -> RecurrenceFormSheet(s.rec) { sheet = null }
            is Sheet.CardForm -> CardFormSheet(s.card) { sheet = null; if (s.card != null && it) cardId = null }
            is Sheet.Cell -> CellSheet(s.column, s.date) { sheet = null }
        }

        if (status is Store.Status.Conflict) {
            AlertDialog(
                onDismissRequest = {},
                title = { Text("Arquivo alterado em outro lugar") },
                text = {
                    Text("O arquivo no Drive mudou (talvez pela web) enquanto havia alterações ainda não enviadas deste celular. Qual versão manter?")
                },
                confirmButton = { TextButton({ scope.launch { store.resolveConflict(keepThisPhone = false) } }) { Text("A do Drive") } },
                dismissButton = { TextButton({ scope.launch { store.resolveConflict(keepThisPhone = true) } }) { Text("A deste celular") } },
            )
        }
    }
}

/** Mês da fatura escolhido em cada cartão (lembrado enquanto o app está aberto). */
val cardMonth = HashMap<Long, String>()

fun newTx(kind: String = "expense", date: LocalDate = LocalDate.now(), cardId: Long? = null, nature: String? = "daily") =
    TxInput(kind, "", 0, date, cardId = cardId, nature = nature)
