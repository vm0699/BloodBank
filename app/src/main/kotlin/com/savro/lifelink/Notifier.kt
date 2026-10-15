package com.savro.lifelink

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * One-shot local notices (e.g. "You can donate blood again", camp reminders): AlarmManager (inexact, no special
 * permission) + a notification. Notices are persisted so they survive a reboot.
 */
object Notifier {
    private const val PREFS = "notices"
    private const val CHANNEL = "lifelink_notices"
    private const val SEP = "\u0001"

    fun set(context: Context, id: Int, whenMillis: Long, title: String, text: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("n$id", listOf(whenMillis, title, text).joinToString(SEP)).apply()
        arm(context, id, whenMillis, title, text)
    }

    fun cancel(context: Context, id: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("n$id").apply()
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending(context, id, "", ""))
    }

    private fun arm(context: Context, id: Int, whenMillis: Long, title: String, text: String) {
        if (whenMillis <= System.currentTimeMillis()) return
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMillis, pending(context, id, title, text))
    }

    private fun pending(context: Context, id: Int, title: String, text: String): PendingIntent =
        PendingIntent.getBroadcast(
            context, id,
            Intent(context, NoticeReceiver::class.java).putExtra("id", id).putExtra("title", title).putExtra("text", text),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    /** Alarms are cleared on reboot, so put the still-future ones back. */
    fun restore(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        for ((k, v) in prefs.all) {
            if (!k.startsWith("n") || v !is String) continue
            val p = v.split(SEP)
            if (p.size < 3) continue
            val id = k.substring(1).toIntOrNull() ?: continue
            arm(context, id, p[0].toLongOrNull() ?: continue, p[1], p[2])
        }
    }

    fun show(context: Context, id: Int, title: String, text: String) {
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL, "Donation reminders", NotificationManager.IMPORTANCE_DEFAULT)
            channel.description = "Eligibility and camp reminders"
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try { nm.notify(1000 + id, n) } catch (_: SecurityException) {}
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("n$id").apply()
    }
}

class NoticeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) =
        Notifier.show(
            context, intent.getIntExtra("id", 0),
            intent.getStringExtra("title") ?: "LifeLink", intent.getStringExtra("text") ?: ""
        )
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) Notifier.restore(context)
    }
}
