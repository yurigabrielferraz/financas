package app.financas.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.financas.R
import app.financas.data.Reminder
import app.financas.store
import app.financas.ui.MainActivity
import app.financas.ui.dueLabel
import app.financas.ui.money
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.LocalDateTime
import java.util.concurrent.TimeUnit

/** Lembretes locais: uma vez por dia (no horário escolhido) o app verifica as contas e notifica. */
object Notifier {
    private const val CHANNEL = "lembretes"
    private const val WORK = "lembretes-diarios"

    fun createChannel(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Lembretes de contas", NotificationManager.IMPORTANCE_HIGH),
        )
    }

    /** Agenda (ou reagenda) a verificação diária para `hour`:00. */
    fun schedule(ctx: Context, hour: Int) {
        val now = LocalDateTime.now()
        var next = now.toLocalDate().atTime(hour, 0)
        if (!next.isAfter(now)) next = next.plusDays(1)
        val req = PeriodicWorkRequestBuilder<ReminderWorker>(1, TimeUnit.DAYS)
            .setInitialDelay(Duration.between(now, next).toMinutes(), TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, req)
    }

    fun runNow(ctx: Context) {
        WorkManager.getInstance(ctx).enqueue(OneTimeWorkRequestBuilder<ReminderWorker>().build())
    }

    fun canNotify(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun show(ctx: Context, items: List<Reminder>) {
        if (!canNotify(ctx)) return
        val open = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val nm = NotificationManagerCompat.from(ctx)
        for (r in items) {
            val nid = r.key.hashCode()
            val b = NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("${r.description} — ${dueLabel(r.daysUntil)}")
                .setContentText(money(r.amount))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
            if (r.txId != null) {
                val pay = PendingIntent.getBroadcast(
                    ctx, nid, Intent(ctx, PayReceiver::class.java).putExtra("tx", r.txId).putExtra("nid", nid),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                b.addAction(0, "Marcar como paga", pay)
            }
            try {
                nm.notify(nid, b.build())
            } catch (_: SecurityException) { /* permissão revogada */ }
        }
    }
}

class ReminderWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val store = applicationContext.store
        if (store.uri == null) return Result.success()
        store.sync() // pega a versão mais nova do Drive, se houver
        Notifier.show(applicationContext, store.read { it.reminders() })
        return Result.success()
    }
}

/** Botão "Marcar como paga" da notificação. */
class PayReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getLongExtra("tx", -1)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                ctx.store.write { it.payTransaction(id) }
                ctx.store.sync()
                NotificationManagerCompat.from(ctx).cancel(intent.getIntExtra("nid", 0))
            } finally {
                pending.finish()
            }
        }
    }
}
