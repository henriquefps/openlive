// SPDX-License-Identifier: AGPL-3.0-only
package dev.hfps.openlive.audio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Where a call's sound goes: the speaker, the earpiece, a wired headset or a Bluetooth headset
 * (SCO, or LE Audio). Android 12+ picks a "communication device" (AudioManager.setCommunicationDevice);
 * older versions use the speakerphone switch and Bluetooth SCO. The preference is `auto` (a headset
 * when one is connected, else the speaker), `speaker` or `earpiece`.
 */
class VoiceRouter(private val context: Context, private val onChange: (Map<String, Any?>) -> Unit) {
  private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val main = Handler(Looper.getMainLooper())
  private var preference = "auto"
  private var running = false
  private var scoWanted = false

  private val devices =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = refresh()

      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = refresh()
    }

  private val sco =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) = emit()
    }

  // Android 12+ only; typed loosely so older versions never load the class.
  private val communicationListener: Any? =
    if (Build.VERSION.SDK_INT >= 31) AudioManager.OnCommunicationDeviceChangedListener { emit() } else null

  fun start(preference: String) {
    this.preference = preference
    if (!running) {
      running = true
      manager.registerAudioDeviceCallback(devices, main)
      if (Build.VERSION.SDK_INT >= 31) {
        manager.addOnCommunicationDeviceChangedListener(
          context.mainExecutor,
          communicationListener as AudioManager.OnCommunicationDeviceChangedListener,
        )
      } else {
        context.registerReceiver(sco, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
      }
    }
    apply()
    emit()
  }

  fun isRunning(): Boolean = running

  fun set(preference: String) {
    this.preference = preference
    if (running) apply()
    emit()
  }

  fun stop() {
    if (!running) return
    running = false
    manager.unregisterAudioDeviceCallback(devices)
    if (Build.VERSION.SDK_INT >= 31) {
      manager.removeOnCommunicationDeviceChangedListener(
        communicationListener as AudioManager.OnCommunicationDeviceChangedListener
      )
      manager.clearCommunicationDevice()
    } else {
      runCatching { context.unregisterReceiver(sco) }
      @Suppress("DEPRECATION") manager.isSpeakerphoneOn = false
      stopSco()
    }
  }

  /** {active, available} for JavaScript. */
  fun info(): Map<String, Any?> = mapOf("active" to active(), "available" to available().toList())

  // -- choosing ---------------------------------------------------------------------------------

  private fun refresh() {
    if (running && preference == "auto") apply()
    emit()
  }

  private fun apply() {
    val available = available()
    val target =
      when (preference) {
        "speaker" -> "speaker"
        "earpiece" -> if ("earpiece" in available) "earpiece" else "speaker"
        else ->
          when {
            "wired" in available -> "wired"
            "bluetooth" in available -> "bluetooth"
            else -> "speaker"
          }
      }
    if (Build.VERSION.SDK_INT >= 31) {
      val device = manager.availableCommunicationDevices.firstOrNull { classify(it) == target }
      if (device == null) manager.clearCommunicationDevice() else manager.setCommunicationDevice(device)
    } else {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = target == "speaker"
      if (target == "bluetooth") startSco() else stopSco()
    }
  }

  @Suppress("DEPRECATION")
  private fun startSco() {
    if (scoWanted) return
    scoWanted = true
    manager.startBluetoothSco()
    manager.isBluetoothScoOn = true
  }

  @Suppress("DEPRECATION")
  private fun stopSco() {
    if (!scoWanted) return
    scoWanted = false
    manager.isBluetoothScoOn = false
    manager.stopBluetoothSco()
  }

  private fun available(): Set<String> {
    val found = linkedSetOf("speaker")
    val list: List<AudioDeviceInfo> =
      if (Build.VERSION.SDK_INT >= 31) manager.availableCommunicationDevices
      else manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    for (device in list) classify(device)?.let { found.add(it) }
    return found
  }

  private fun active(): String {
    if (Build.VERSION.SDK_INT >= 31) {
      return manager.communicationDevice?.let { classify(it) } ?: "speaker"
    }
    @Suppress("DEPRECATION")
    return when {
      manager.isBluetoothScoOn -> "bluetooth"
      manager.isSpeakerphoneOn -> "speaker"
      "wired" in available() -> "wired"
      "earpiece" in available() -> "earpiece"
      else -> "speaker"
    }
  }

  private fun emit() = onChange(info())

  private fun classify(device: AudioDeviceInfo): String? =
    when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
      else -> if (Build.VERSION.SDK_INT >= 31 && device.type == AudioDeviceInfo.TYPE_BLE_HEADSET) "bluetooth" else null
    }
}
