package com.savro.lifelink

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives Firebase Cloud Messaging pushes from the LifeLink backend (urgent request nearby, donor accepted, ...).
 * Pushes sent while the app is in the background are shown by the system; this handles the foreground case.
 * Inactive until the Firebase project's google-services.json is added to app/ (see docs/BACKEND.md).
 */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val n = message.notification
        val title = n?.title ?: message.data["title"] ?: "LifeLink"
        val body = n?.body ?: message.data["body"] ?: ""
        Notifier.show(this, (message.data["id"]?.hashCode() ?: 0) and 0xFFFF, title, body)
    }

    override fun onNewToken(token: String) {
        getSharedPreferences("push", MODE_PRIVATE).edit().putString("token", token).apply()
    }
}
