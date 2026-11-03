// SPDX-License-Identifier: AGPL-3.0-only
package dev.hfps.openlive.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The app's audio mode (apps/mobile/README.md, "Audio"): what the phone thinks the app is doing.
//
//   media          Watching a stream: AudioManager MODE_NORMAL, the media volume (STREAM_MUSIC) on the
//                  volume keys, audio focus as a movie player (GAIN), Bluetooth A2DP when connected.
//   communication  Talking (voice, A3): MODE_IN_COMMUNICATION, the call volume on the keys and
//                  transient focus as a voice call.
//
// Audio focus changes go to JavaScript as `onFocusChange` ("gain", "duck", "loss_transient",
// "loss"), which sets the stream's gain (a phone call mutes it, another app's music mutes it, a
// notification ducks it). The playout's own AudioAttributes (USAGE_MEDIA) are fixed when the
// WebRTC audio device is built, in MainApplication (plugins/with-openlive-audio.js).
class OpenliveAudioModule : Module() {
  private var request: AudioFocusRequest? = null
  private var savedMode: Int? = null
  private var communicationMode = false
  private val handler = Handler(Looper.getMainLooper())

  private val audioManager: AudioManager
    get() = appContext.reactContext!!.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun definition() = ModuleDefinition {
    Name("OpenliveAudio")

    Events("onFocusChange")

    Function("setMode") { mode: String -> apply(mode) }

    Function("release") { release() }

    // A short notice cue (notices, apps/mobile/src/notices): 16-bit mono PCM in base64.
    Function("playCue") { pcmBase64: String, sampleRate: Int -> playCue(pcmBase64, sampleRate) }

    OnDestroy { release() }
  }

  private fun apply(mode: String) {
    val communication = mode == "communication"
    communicationMode = communication
    val manager = audioManager
    if (savedMode == null) savedMode = manager.mode
    manager.mode = if (communication) AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
    volumeStream(if (communication) AudioManager.STREAM_VOICE_CALL else AudioManager.STREAM_MUSIC)

    abandon()
    val attributes =
      AudioAttributes.Builder()
        .setUsage(
          if (communication) AudioAttributes.USAGE_VOICE_COMMUNICATION
          else AudioAttributes.USAGE_MEDIA
        )
        .setContentType(
          if (communication) AudioAttributes.CONTENT_TYPE_SPEECH
          else AudioAttributes.CONTENT_TYPE_MOVIE
        )
        .build()
    val built =
      AudioFocusRequest.Builder(
          if (communication) AudioManager.AUDIOFOCUS_GAIN_TRANSIENT else AudioManager.AUDIOFOCUS_GAIN
        )
        .setAudioAttributes(attributes)
        // We lower the gain ourselves (JavaScript), so the system does not duck on its own.
        .setWillPauseWhenDucked(true)
        .setOnAudioFocusChangeListener { change -> sendEvent("onFocusChange", mapOf("state" to state(change))) }
        .build()
    request = built
    val result = manager.requestAudioFocus(built)
    if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      sendEvent("onFocusChange", mapOf("state" to "loss_transient"))
    } else {
      sendEvent("onFocusChange", mapOf("state" to "gain"))
    }
  }

  /**
   * Plays the cue without taking audio focus, so a stream being watched keeps playing under it:
   * on the call route (voice communication) while in voice, else as a notification sound.
   */
  private fun playCue(pcmBase64: String, sampleRate: Int) {
    val bytes = Base64.decode(pcmBase64, Base64.NO_WRAP)
    if (bytes.isEmpty()) return
    val attributes =
      AudioAttributes.Builder()
        .setUsage(
          if (communicationMode) AudioAttributes.USAGE_VOICE_COMMUNICATION
          else AudioAttributes.USAGE_ASSISTANCE_SONIFICATION
        )
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
    val format =
      AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(sampleRate)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build()
    val track =
      AudioTrack.Builder()
        .setAudioAttributes(attributes)
        .setAudioFormat(format)
        .setBufferSizeInBytes(bytes.size)
        .setTransferMode(AudioTrack.MODE_STATIC)
        .build()
    track.write(bytes, 0, bytes.size)
    track.play()
    val ms = bytes.size / 2 * 1000L / sampleRate
    handler.postDelayed({ track.release() }, ms + 300)
  }

  private fun release() {
    communicationMode = false
    abandon()
    val manager = audioManager
    savedMode?.let { manager.mode = AudioManager.MODE_NORMAL }
    savedMode = null
    volumeStream(AudioManager.USE_DEFAULT_STREAM_TYPE)
  }

  private fun abandon() {
    request?.let { audioManager.abandonAudioFocusRequest(it) }
    request = null
  }

  /** The hardware volume keys control this stream while the app is in front. */
  private fun volumeStream(stream: Int) {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread { activity.volumeControlStream = stream }
  }

  private fun state(change: Int): String =
    when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> "gain"
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "duck"
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "loss_transient"
      else -> "loss"
    }
}
