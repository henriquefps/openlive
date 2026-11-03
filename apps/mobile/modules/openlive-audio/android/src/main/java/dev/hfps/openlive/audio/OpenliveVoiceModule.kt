// SPDX-License-Identifier: AGPL-3.0-only
package dev.hfps.openlive.audio

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.oney.WebRTCModule.OpenliveWebrtcBridge
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The phone side of a voice call (apps/mobile/src/voice-native): the foreground service and its
// notification, the voice audio device, the route and a microphone level meter. No voice logic.
class OpenliveVoiceModule : Module() {
  private var router: VoiceRouter? = null
  private var monitor: MicMonitor? = null

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready", null)

  private fun reactContext(): ReactApplicationContext =
    appContext.reactContext as? ReactApplicationContext
      ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready", null)

  override fun definition() = ModuleDefinition {
    Name("OpenliveVoice")

    Events("onNotificationAction", "onSessionEnded", "onRouteChange", "onMicLevel")

    OnCreate {
      VoiceBridge.attach { name, body -> sendEvent(name, body) }
      trackActivities()
    }

    OnDestroy {
      VoiceBridge.detach()
      router?.stop()
      monitor?.stop()
    }

    AsyncFunction("startService") { options: Map<String, Any?> -> startService(options) }

    Function("updateService") { options: Map<String, Any?> ->
      if (VoiceBridge.wanted) VoiceSessionService.instance?.update(texts(options))
    }

    Function("stopService") {
      VoiceBridge.wanted = false
      val service = VoiceSessionService.instance
      if (service != null) service.finish()
      else context.stopService(Intent(context, VoiceSessionService::class.java))
    }

    Function("useVoiceDevice") {
      val swapped = OpenliveWebrtcBridge.useVoiceDevice(reactContext())
      mapOf(
        "hardwareAec" to OpenliveWebrtcBridge.hardwareAec(),
        "hardwareNs" to OpenliveWebrtcBridge.hardwareNs(),
        "swapped" to swapped,
      )
    }

    Function("useMediaDevice") {
      OpenliveWebrtcBridge.useMediaDevice(reactContext())
    }

    Function("setRoute") { preference: String ->
      val current = router ?: VoiceRouter(context) { info -> sendEvent("onRouteChange", info) }.also { router = it }
      if (current.isRunning()) current.set(preference) else current.start(preference)
    }

    Function("clearRoute") {
      router?.stop()
      router = null
    }

    Function("getRoute") { router?.info() ?: VoiceRouter(context) {}.info() }

    Function("startMicMonitor") {
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
          PackageManager.PERMISSION_GRANTED
      ) {
        throw CodedException("ERR_MIC_PERMISSION", "The microphone permission is not granted", null)
      }
      monitor?.stop()
      monitor = MicMonitor { level -> sendEvent("onMicLevel", mapOf("level" to level)) }.also { it.start() }
    }

    Function("stopMicMonitor") {
      monitor?.stop()
      monitor = null
    }
  }

  private fun texts(options: Map<String, Any?>) =
    VoiceSessionService.Texts(
      title = options["title"] as? String ?: "",
      text = options["text"] as? String ?: "",
      mute = options["mute"] as? String ?: "Mute",
      unmute = options["unmute"] as? String ?: "Unmute",
      leave = options["leave"] as? String ?: "Leave",
      channel = options["channel"] as? String ?: "Voice call",
      muted = options["muted"] as? Boolean ?: false,
      microphone = options["microphone"] as? Boolean ?: true,
    )

  /** Starts the foreground service and waits until the system accepted it (or refused). */
  private fun startService(options: Map<String, Any?>) {
    val texts = texts(options)
    val context = context
    if (texts.microphone &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
          PackageManager.PERMISSION_GRANTED
    ) {
      throw CodedException("ERR_MIC_PERMISSION", "The microphone permission is not granted", null)
    }
    VoiceBridge.wanted = true
    VoiceBridge.status = "starting"
    try {
      val intent =
        VoiceSessionService.put(Intent(context, VoiceSessionService::class.java).setAction(VoiceSessionService.ACTION_START), texts)
      ContextCompat.startForegroundService(context, intent)
    } catch (e: Exception) {
      // Android 12+: not allowed from the background.
      VoiceBridge.wanted = false
      VoiceBridge.status = "idle"
      throw CodedException("ERR_SERVICE", e.message ?: "The service could not start", e)
    }
    val deadline = System.currentTimeMillis() + START_TIMEOUT_MS
    while (System.currentTimeMillis() < deadline) {
      val status = VoiceBridge.status
      if (status == "running") return
      if (status.startsWith("failed")) {
        VoiceBridge.status = "idle"
        throw CodedException("ERR_SERVICE", status, null)
      }
      if (!VoiceBridge.wanted) throw CodedException("ERR_SERVICE", "The call was stopped while it started", null)
      Thread.sleep(25)
    }
    VoiceBridge.wanted = false
    throw CodedException("ERR_SERVICE", "The service did not start in time", null)
  }

  private fun trackActivities() {
    if (tracking) return
    tracking = true
    (context.applicationContext as? Application)?.registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
          VoiceBridge.startedActivities.incrementAndGet()
        }

        override fun onActivityStopped(activity: Activity) {
          VoiceBridge.startedActivities.updateAndGet { maxOf(0, it - 1) }
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

        override fun onActivityResumed(activity: Activity) = Unit

        override fun onActivityPaused(activity: Activity) = Unit

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

        override fun onActivityDestroyed(activity: Activity) = Unit
      }
    )
  }

  companion object {
    private const val START_TIMEOUT_MS = 4000L
    private var tracking = false
  }
}
