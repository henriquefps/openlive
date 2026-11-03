// SPDX-License-Identifier: AGPL-3.0-only
package dev.hfps.openlive.audio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * A microphone level meter for the debug screen: reads the voice-call microphone source (the one
 * voice uses, with the platform's echo canceller and noise suppressor when it has them) and reports
 * a level from 0 to 1, ten times a second. Nothing is recorded or kept.
 */
class MicMonitor(private val onLevel: (Double) -> Unit) {
  @Volatile private var thread: Thread? = null

  fun start() {
    if (thread != null) return
    val rate = 16000
    val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val record =
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        rate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(min, rate / 5 * 2),
      )
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      throw IllegalStateException("The microphone could not be opened")
    }
    val effects =
      listOfNotNull(
        if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(record.audioSessionId) else null,
        if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(record.audioSessionId) else null,
      )
    effects.forEach { it.enabled = true }
    record.startRecording()
    thread =
      Thread {
          val samples = ShortArray(rate / 10)
          while (thread === Thread.currentThread()) {
            val read = record.read(samples, 0, samples.size)
            if (read <= 0) break
            var sum = 0.0
            for (i in 0 until read) sum += samples[i].toDouble() * samples[i]
            val rms = sqrt(sum / read)
            // -60 dBFS is silence on the meter, 0 dBFS is full.
            val db = if (rms > 0) 20 * log10(rms / 32768.0) else -90.0
            onLevel(((db + 60) / 60).coerceIn(0.0, 1.0))
          }
          effects.forEach { it.release() }
          record.stop()
          record.release()
        }
        .also {
          it.name = "openlive-mic-monitor"
          it.start()
        }
  }

  fun stop() {
    thread = null
  }
}
