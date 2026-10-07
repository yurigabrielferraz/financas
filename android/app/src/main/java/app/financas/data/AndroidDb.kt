package app.financas.data

import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase

/** Db sobre o SQLite do Android. Argumentos tipados (Long/String/null) via CursorFactory. */
class AndroidDb(path: String) : Db {
    private val db: SQLiteDatabase =
        SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY).apply {
            // arquivo único, sem -wal: é ele que vai para o Google Drive
            disableWriteAheadLogging()
            setForeignKeyConstraintsEnabled(true)
        }

    override fun query(sql: String, vararg args: Any?): List<Row> {
        val factory = SQLiteDatabase.CursorFactory { _, driver, table, q ->
            args.forEachIndexed { i, raw ->
                when (val a = sqlArg(raw)) {
                    null -> q.bindNull(i + 1)
                    is Long -> q.bindLong(i + 1, a)
                    is Double -> q.bindDouble(i + 1, a)
                    is ByteArray -> q.bindBlob(i + 1, a)
                    else -> q.bindString(i + 1, a.toString())
                }
            }
            SQLiteCursor(driver, table, q)
        }
        return db.rawQueryWithFactory(factory, sql, null, "").use { c ->
            buildList {
                while (c.moveToNext()) {
                    add((0 until c.columnCount).associate { i ->
                        c.getColumnName(i) to when (c.getType(i)) {
                            Cursor.FIELD_TYPE_NULL -> null
                            Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
                            Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
                            Cursor.FIELD_TYPE_BLOB -> c.getBlob(i)
                            else -> c.getString(i)
                        }
                    })
                }
            }
        }
    }

    override fun exec(sql: String, vararg args: Any?) {
        if (args.isEmpty()) db.execSQL(sql) else db.execSQL(sql, args.map(::sqlArg).toTypedArray())
    }

    override fun <T> tx(block: () -> T): T {
        db.beginTransaction()
        try {
            val r = block()
            db.setTransactionSuccessful()
            return r
        } finally {
            db.endTransaction()
        }
    }

    override var userVersion: Int
        get() = db.version
        set(v) { db.version = v }

    fun close() = db.close()
}
