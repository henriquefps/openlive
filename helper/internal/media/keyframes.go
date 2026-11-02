// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"sync"
	"time"
)

// Keyframes turns keyframe requests (RTCP PLI/FIR for one layer) into forced IDRs,
// rate-limited and coalesced:
//   - outside the window, a request forces an IDR at once;
//   - inside it, the request is not dropped: it schedules one IDR at the end of the
//     window, and every further request until then joins that one.
//
// So a viewer that joins right after an IDR still gets its own one soon, and a burst of
// PLIs costs one IDR.
type Keyframes struct {
	minInterval time.Duration
	force       func()
	now         func() time.Time
	afterFunc   func(time.Duration, func())

	mu         sync.Mutex
	lastForced time.Time
	pending    bool
	stats      KeyframeStats
}

// KeyframeStats counts what Keyframes did.
type KeyframeStats struct {
	Requests  int
	Forced    int
	Coalesced int
}

// NewKeyframes calls force for every IDR it decides on.
func NewKeyframes(minInterval time.Duration, force func()) *Keyframes {
	return &Keyframes{
		minInterval: minInterval,
		force:       force,
		now:         time.Now,
		afterFunc:   func(d time.Duration, f func()) { time.AfterFunc(d, f) },
	}
}

// Request handles one PLI/FIR.
func (k *Keyframes) Request() {
	k.mu.Lock()
	k.stats.Requests++
	now := k.now()
	switch {
	case k.pending:
		k.stats.Coalesced++
		k.mu.Unlock()
	case k.lastForced.IsZero() || now.Sub(k.lastForced) >= k.minInterval:
		k.lastForced = now
		k.stats.Forced++
		k.mu.Unlock()
		k.force()
	default:
		k.pending = true
		k.stats.Coalesced++
		wait := k.minInterval - now.Sub(k.lastForced)
		k.mu.Unlock()
		k.afterFunc(wait, k.fireDeferred)
	}
}

func (k *Keyframes) fireDeferred() {
	k.mu.Lock()
	k.pending = false
	k.lastForced = k.now()
	k.stats.Forced++
	k.mu.Unlock()
	k.force()
}

// Stats returns a copy of the counters.
func (k *Keyframes) Stats() KeyframeStats {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.stats
}
