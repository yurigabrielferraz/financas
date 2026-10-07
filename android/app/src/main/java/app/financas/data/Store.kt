package app.financas.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.time.LocalTime

/**
 * Banco local + sincronização com o arquivo escolhido no Google Drive (via seletor de arquivos do Android).
 *
 * - O app trabalha numa cópia local (filesDir/financas.db).
 * - Cada alteração marca "dirty" e envia o arquivo inteiro ao Drive ~1,5 s depois.
 * - Ao abrir/voltar ao app, baixa o arquivo do Drive e compara o hash com o da última sincronização:
 *   mudou lá e não aqui -> substitui a cópia local; mudou nos dois -> conflito (usuário escolhe).
 * ponytail: arquivo inteiro a cada sync (KBs). Sincronização por registro só se o arquivo ficar grande.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class Store(private val ctx: Context) {

    sealed interface Status {
        data object Idle : Status
        data object Syncing : Status
        data class Ok(val at: LocalTime) : Status
        data class Offline(val message: String) : Status
        data object Conflict : Status
        data class Error(val message: String) : Status
    }

    private val prefs = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE)
    private val local = File(ctx.filesDir, "financas.db")
    /** Uma thread só para banco e sincronização: nada roda em paralelo sobre o arquivo. */
    private val io = Dispatchers.IO.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var db: AndroidDb? = null
    private var repo: Repo? = null
    private var pushJob: Job? = null

    /** Muda a cada alteração ou download: as telas observam para recarregar. */
    val version = MutableStateFlow(0)
    val status = MutableStateFlow<Status>(Status.Idle)
    val uriFlow = MutableStateFlow(prefs.getString("uri", null)?.let(Uri::parse))

    val uri: Uri? get() = uriFlow.value
    private var baseHash: String?
        get() = prefs.getString("hash", null)
        set(v) = prefs.edit().putString("hash", v).apply()
    private var dirty: Boolean
        get() = prefs.getBoolean("dirty", false)
        set(v) = prefs.edit().putBoolean("dirty", v).apply()

    fun fileName(): String? = uri?.let { u ->
        runCatching {
            ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
        }.getOrNull()
    }

    private fun asset(name: String) = ctx.assets.open(name).bufferedReader().use { it.readText() }

    private fun repo(): Repo = repo ?: run {
        val d = AndroidDb(local.path)
        try {
            Repo(d).also { it.upgrade(asset("schema.sql"), asset("seed.sql")) }
        } catch (e: Exception) {
            d.close(); throw e
        }.also { db = d; repo = it }
    }

    private fun closeDb() {
        db?.close(); db = null; repo = null
    }

    suspend fun <T> read(block: (Repo) -> T): T = withContext(io) { block(repo()) }

    /** Alteração feita pelo usuário: grava local e agenda o envio ao Drive. */
    suspend fun <T> write(block: (Repo) -> T): T = withContext(io) {
        val r = block(repo())
        dirty = true
        version.value++
        pushJob?.cancel()
        pushJob = scope.launch { delay(1500); sync() }
        r
    }

    private fun readRemote(u: Uri): ByteArray =
        ctx.contentResolver.openInputStream(u)?.use { it.readBytes() } ?: error("Não foi possível ler o arquivo")

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun push(u: Uri) {
        closeDb()
        val bytes = local.readBytes()
        ctx.contentResolver.openOutputStream(u, "wt")?.use { it.write(bytes) } ?: error("Não foi possível gravar no arquivo")
        baseHash = sha(bytes)
        dirty = false
    }

    private fun replaceLocal(bytes: ByteArray) {
        closeDb()
        val tmp = File(ctx.filesDir, "financas.db.tmp")
        tmp.writeBytes(bytes)
        tmp.renameTo(local)
        File(ctx.filesDir, "financas.db-journal").delete()
        baseHash = sha(bytes)
        dirty = false
        repo() // valida o arquivo (e atualiza o formato, se for antigo)
        version.value++
    }

    /** Sincroniza com o Drive. Em conflito, para e espera [resolveConflict]. */
    suspend fun sync() = withContext(io) {
        val u = uri ?: return@withContext
        status.value = Status.Syncing
        try {
            val remote = readRemote(u)
            val changedThere = sha(remote) != baseHash
            when {
                !changedThere && dirty -> push(u)
                changedThere && !dirty -> replaceLocal(remote)
                changedThere && dirty -> { status.value = Status.Conflict; return@withContext }
            }
            status.value = Status.Ok(LocalTime.now())
        } catch (e: Repo.NewerSchemaException) {
            status.value = Status.Error(e.message ?: "")
        } catch (e: Exception) {
            status.value = Status.Offline(e.message ?: e.javaClass.simpleName)
        }
    }

    suspend fun resolveConflict(keepThisPhone: Boolean) = withContext(io) {
        val u = uri ?: return@withContext
        try {
            if (keepThisPhone) push(u) else replaceLocal(readRemote(u))
            status.value = Status.Ok(LocalTime.now())
        } catch (e: Exception) {
            status.value = Status.Offline(e.message ?: e.javaClass.simpleName)
        }
    }

    /** Passa a usar o arquivo escolhido. `create`: arquivo novo/vazio, recebe os dados iniciais deste celular. */
    suspend fun useFile(u: Uri, create: Boolean) = withContext(io) {
        prefs.edit().putString("uri", u.toString()).apply()
        uriFlow.value = u
        baseHash = null
        try {
            val remote = if (create) ByteArray(0) else readRemote(u)
            if (remote.isEmpty()) {
                closeDb()
                local.delete()
                repo()
                push(u)
                version.value++
            } else {
                replaceLocal(remote)
            }
            status.value = Status.Ok(LocalTime.now())
        } catch (e: Exception) {
            status.value = Status.Error(e.message ?: e.javaClass.simpleName)
        }
    }
}
