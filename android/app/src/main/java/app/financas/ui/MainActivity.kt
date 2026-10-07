package app.financas.ui

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import app.financas.notify.Notifier
import app.financas.store
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 33 && !Notifier.canNotify(this)) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent { AppTheme { Root() } }
    }

    override fun onResume() {
        super.onResume()
        // ao voltar para o app: pega alterações feitas no Drive (ex.: pela web) e reagenda os lembretes
        lifecycleScope.launch {
            if (store.uri == null) return@launch
            store.sync()
            runCatching { Notifier.schedule(this@MainActivity, store.read { it.notifyHour() }) }
        }
    }
}
