package app.financas.data

import java.time.LocalDate

/** Linha de resultado: nome da coluna -> valor (Long, Double, String, ByteArray ou null). */
typealias Row = Map<String, Any?>

fun Row.long(k: String): Long = (this[k] as Number).toLong()
fun Row.longOrNull(k: String): Long? = (this[k] as Number?)?.toLong()
fun Row.int(k: String): Int = (this[k] as Number).toInt()
fun Row.intOrNull(k: String): Int? = (this[k] as Number?)?.toInt()
fun Row.str(k: String): String = this[k] as String
fun Row.strOrNull(k: String): String? = this[k] as String?
fun Row.bool(k: String): Boolean = ((this[k] as Number?)?.toLong() ?: 0L) != 0L
fun Row.date(k: String): LocalDate = LocalDate.parse(str(k))
fun Row.dateOrNull(k: String): LocalDate? = strOrNull(k)?.let(LocalDate::parse)

/** Acesso mínimo ao SQLite: implementado com o SQLite do Android no app e com JDBC nos testes. */
interface Db {
    fun query(sql: String, vararg args: Any?): List<Row>
    fun exec(sql: String, vararg args: Any?)
    fun <T> tx(block: () -> T): T
    var userVersion: Int

    fun one(sql: String, vararg args: Any?): Row? = query(sql, *args).firstOrNull()
    fun scalar(sql: String, vararg args: Any?): Long =
        (query(sql, *args).firstOrNull()?.values?.firstOrNull() as Number?)?.toLong() ?: 0L

    fun insert(sql: String, vararg args: Any?): Long {
        exec(sql, *args)
        return scalar("SELECT last_insert_rowid()")
    }

    fun script(sql: String) = splitSql(sql).forEach { exec(it) }
}

/** Converte argumentos para tipos que o SQLite entende. */
fun sqlArg(a: Any?): Any? = when (a) {
    null -> null
    is Boolean -> if (a) 1L else 0L
    is Int -> a.toLong()
    is LocalDate -> a.toString()
    is Long, is Double, is String, is ByteArray -> a
    else -> a.toString()
}

/** Separa um script em comandos (ignora linhas de comentário). Os .sql do projeto não têm ';' em textos. */
fun splitSql(sql: String): List<String> = sql.lines()
    .filterNot { it.trimStart().startsWith("--") }
    .joinToString("\n")
    .split(';')
    .map { it.trim() }
    .filter { it.isNotEmpty() }
