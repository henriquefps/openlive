// SPDX-License-Identifier: AGPL-3.0-only
package dev.hfps.openlive.audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.Process

/**
 * Keeps a voice call alive while the app is in the background or the screen is locked: a foreground
 * service of type microphone (| mediaPlayback), the ongoing notification "In voice in #room" with
 * mute and leave, and a CPU and Wi-Fi lock so the connection survives the screen turning off.
 *
 * The notification's buttons go to JavaScript as `onNotificationAction`; JavaScript is the one
 * that mutes and leaves, and tells the service the new state (`update`). Swiping the app away ends
 * the call: JavaScript is told (`onSessionEnded`), and a few seconds later the service stops and,
 * if the app is still not on screen, the process is killed so nothing keeps the microphone.
 */
class VoiceSessionService : Service() {
  private var texts = Texts()
  private var started = false
  private var startedAt = 0L
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private val main = Handler(Looper.getMainLooper())

  data class Texts(
    val title: String = "",
    val text: String = "",
    val mute: String = "Mute",
    val unmute: String = "Unmute",
    val leave: String = "Leave",
    val channel: String = "Voice call",
    val muted: Boolean = false,
    val microphone: Boolean = true,
  )

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        texts = read(intent)
        begin()
      }
      ACTION_TOGGLE_MUTE ->
        VoiceBridge.emit("onNotificationAction", mapOf("action" to if (texts.muted) "unmute" else "mute"))
      ACTION_LEAVE -> {
        VoiceBridge.emit("onNotificationAction", mapOf("action" to "leave"))
        // Without JavaScript to leave the room, the call is over for the phone anyway.
        if (!VoiceBridge.attached) finish()
      }
      else -> if (!started) stopSelf()
    }
    return START_NOT_STICKY
  }

  /** New texts or mute state (JavaScript's, which is the truth): the notification follows. */
  fun update(next: Texts) {
    texts = next
    if (started) getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build())
  }

  fun finish() {
    main.post {
      releaseLocks()
      started = false
      VoiceBridge.status = "idle"
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The app was swiped away: the call ends. JavaScript leaves the room (and stops the session) if
    // it can; after a short grace the service stops and, unless the app came back, so does the process.
    if (VoiceBridge.wanted) VoiceBridge.emit("onSessionEnded", mapOf("reason" to "task_removed"))
    main.postDelayed(
      {
        if (!VoiceBridge.wanted && !started) return@postDelayed
        VoiceBridge.wanted = false
        finish()
        main.postDelayed(
          { if (VoiceBridge.startedActivities.get() == 0) Process.killProcess(Process.myPid()) },
          500,
        )
      },
      TASK_REMOVED_GRACE_MS,
    )
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    releaseLocks()
    started = false
    if (instance === this) instance = null
    if (VoiceBridge.wanted) {
      // Stopped by the system, not by JavaScript.
      VoiceBridge.wanted = false
      VoiceBridge.status = "idle"
      VoiceBridge.emit("onSessionEnded", mapOf("reason" to "service_stopped"))
    }
    super.onDestroy()
  }

  private fun begin() {
    startedAt = System.currentTimeMillis()
    try {
      val notification = build()
      if (Build.VERSION.SDK_INT >= 29) {
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (texts.microphone) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        startForeground(NOTIFICATION_ID, notification, type)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // Android 14: no microphone permission, or the app is not on screen.
      VoiceBridge.wanted = false
      VoiceBridge.status = "failed: ${e.message}"
      stopSelf()
      return
    }
    started = true
    if (!VoiceBridge.wanted) {
      // Stopped while it was starting; startForeground had to be called all the same.
      finish()
      return
    }
    acquireLocks()
    VoiceBridge.status = "running"
  }

  private fun build(): Notification {
    val builder =
      if (Build.VERSION.SDK_INT >= 26) {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
          NotificationChannel(CHANNEL_ID, texts.channel, NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          }
        )
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
      }
    val open =
      packageManager.getLaunchIntentForPackage(packageName)?.let {
        PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
    val muteLabel = if (texts.muted) texts.unmute else texts.mute
    return builder
      .setSmallIcon(R.drawable.ic_openlive_voice)
      .setContentTitle(texts.title)
      .setContentText(texts.text)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_CALL)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setShowWhen(true)
      .setWhen(startedAt.takeIf { it > 0 } ?: System.currentTimeMillis())
      .setUsesChronometer(true)
      .addAction(action(R.drawable.ic_openlive_voice, muteLabel, ACTION_TOGGLE_MUTE, 1))
      .addAction(action(R.drawable.ic_openlive_voice, texts.leave, ACTION_LEAVE, 2))
      .apply {
        if (Build.VERSION.SDK_INT >= 31) setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
      }
      .build()
  }

  private fun action(icon: Int, label: String, action: String, code: Int): Notification.Action {
    val intent = Intent(this, VoiceSessionService::class.java).setAction(action)
    val pending =
      PendingIntent.getService(this, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return Notification.Action.Builder(Icon.createWithResource(this, icon), label, pending).build()
  }

  @Suppress("DEPRECATION")
  private fun acquireLocks() {
    if (wakeLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock =
        power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "openlive:voice").apply {
          setReferenceCounted(false)
          acquire(MAX_CALL_MS)
        }
    }
    if (wifiLock == null) {
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val mode =
        if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifiLock =
        wifi.createWifiLock(mode, "openlive:voice").apply {
          setReferenceCounted(false)
          acquire()
        }
    }
  }

  private fun releaseLocks() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    wifiLock?.let { if (it.isHeld) it.release() }
    wifiLock = null
  }

  companion object {
    const val ACTION_START = "dev.hfps.openlive.audio.VOICE_START"
    const val ACTION_TOGGLE_MUTE = "dev.hfps.openlive.audio.VOICE_TOGGLE_MUTE"
    const val ACTION_LEAVE = "dev.hfps.openlive.audio.VOICE_LEAVE"
    private const val CHANNEL_ID = "openlive-voice"
    private const val NOTIFICATION_ID = 4101
    private const val MAX_CALL_MS = 12 * 60 * 60 * 1000L
    private const val TASK_REMOVED_GRACE_MS = 3000L

    @Volatile var instance: VoiceSessionService? = null

    fun put(intent: Intent, texts: Texts): Intent =
      intent
        .putExtra("title", texts.title)
        .putExtra("text", texts.text)
        .putExtra("mute", texts.mute)
        .putExtra("unmute", texts.unmute)
        .putExtra("leave", texts.leave)
        .putExtra("channel", texts.channel)
        .putExtra("muted", texts.muted)
        .putExtra("microphone", texts.microphone)

    fun read(intent: Intent): Texts =
      Texts(
        title = intent.getStringExtra("title") ?: "",
        text = intent.getStringExtra("text") ?: "",
        mute = intent.getStringExtra("mute") ?: "Mute",
        unmute = intent.getStringExtra("unmute") ?: "Unmute",
        leave = intent.getStringExtra("leave") ?: "Leave",
        channel = intent.getStringExtra("channel") ?: "Voice call",
        muted = intent.getBooleanExtra("muted", false),
        microphone = intent.getBooleanExtra("microphone", true),
      )
  }
}
