// SPDX-License-Identifier: AGPL-3.0-only
package dev.hfps.openlive.audio

import java.util.concurrent.atomic.AtomicInteger

/**
 * What the foreground service and the JavaScript module share: whether a call is wanted, the
 * service's start status, and a way to send events to JavaScript (the module attaches while the
 * React context is alive).
 */
object VoiceBridge {
  /** JavaScript wants the service up. Set before it starts, cleared before it is stopped. */
  @Volatile var wanted = false

  /** "idle", "starting", "running" or "failed: <why>". */
  @Volatile var status = "idle"

  /** Activities in the started state: zero means the app is not on screen. */
  val startedActivities = AtomicInteger(0)

  @Volatile private var sink: ((String, Map<String, Any?>) -> Unit)? = null
  private val lock = Any()
  private var pendingEnd: Map<String, Any?>? = null

  val attached: Boolean
    get() = sink != null

  fun attach(next: (String, Map<String, Any?>) -> Unit) {
    val replay: Map<String, Any?>?
    synchronized(lock) {
      sink = next
      replay = pendingEnd
      pendingEnd = null
    }
    if (replay != null) next("onSessionEnded", replay)
  }

  fun detach() {
    synchronized(lock) { sink = null }
  }

  fun emit(name: String, payload: Map<String, Any?>) {
    val target = synchronized(lock) { sink }
    if (target != null) {
      target(name, payload)
    } else if (name == "onSessionEnded") {
      // The app's JavaScript is not up (yet): tell it the call is over when it is.
      synchronized(lock) { pendingEnd = payload }
    }
  }
}
