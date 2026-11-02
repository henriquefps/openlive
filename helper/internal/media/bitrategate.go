// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"sync"
	"time"
)

// bitrateGate spaces out the bitrate changes of one encoder (vaBitrateGap for VA-API). A change applies at once when
// the last one is at least gap old; otherwise it waits for the end of the gap, and only
// the latest waiting value is applied.
type bitrateGate struct {
	gap   time.Duration
	apply func(kbps int)

	mu      sync.Mutex
	last    time.Time
	applied int
	pending int
	timer   *time.Timer
	closed  bool
}

func newBitrateGate(gap time.Duration, start int, apply func(kbps int)) *bitrateGate {
	return &bitrateGate{gap: gap, apply: apply, applied: start}
}

func (g *bitrateGate) set(kbps int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return
	}
	if g.timer == nil && kbps == g.applied {
		return
	}
	wait := g.gap - time.Since(g.last)
	if g.last.IsZero() || wait <= 0 {
		g.applyLocked(kbps)
		return
	}
	g.pending = kbps
	if g.timer == nil {
		g.timer = time.AfterFunc(wait, g.flush)
	}
}

func (g *bitrateGate) flush() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.timer = nil
	if g.closed || g.pending == g.applied {
		return
	}
	g.applyLocked(g.pending)
}

func (g *bitrateGate) applyLocked(kbps int) {
	g.last, g.applied = time.Now(), kbps
	g.apply(kbps)
}

// close drops a waiting change (the encoder is going away).
func (g *bitrateGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	if g.timer != nil {
		g.timer.Stop()
		g.timer = nil
	}
}
