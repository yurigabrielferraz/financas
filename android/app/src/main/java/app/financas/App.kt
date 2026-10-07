package app.financas

import android.app.Application
import android.content.Context
import app.financas.data.Store
import app.financas.notify.Notifier

class App : Application() {
    lateinit var store: Store

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        Notifier.createChannel(this)
    }
}

val Context.store: Store get() = (applicationContext as App).store
