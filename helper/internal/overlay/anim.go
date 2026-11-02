// SPDX-License-Identifier: AGPL-3.0-only

package overlay

import "time"

// Duration is how long one ping is drawn (PROTOCOL.md §7.9: about 2 seconds).
const Duration = 2 * time.Second

// Animation timing.
const (
	popIn     = 120 * time.Millisecond // the marker and the name grow in
	fadeOut   = 400 * time.Millisecond // and fade out at the end
	ringEvery = 600 * time.Millisecond // a new ring starts this often
	ringLife  = 1000 * time.Millisecond
	rings     = 3
)

// Sizes in logical pixels.
const (
	ringMin = 9.0  // a ring starts at the marker's size
	ringMax = 40.0 // and grows to this radius
	margin  = 4.0  // room for the ring's stroke and shadow
	// radius is the marker's half-size in the surface: the largest ring plus its stroke.
	radius = ringMax + margin
)

// Ring is one expanding ring of a frame.
type Ring struct {
	Radius float64 // logical pixels
	Alpha  float64 // 0 to 1
}

// Look is one frame of a ping's animation.
type Look struct {
	// Rings are the expanding rings now visible, oldest first.
	Rings []Ring
	// Marker is the shape's scale (0 to 1) and Alpha its opacity, shared with the name.
	Marker, Alpha float64
}

// LookAt is the animation at elapsed time since the ping arrived; done once it is over.
// The marker pops in, stays while rings pulse out of it in the sender's color and fades
// out with its name at the end.
func LookAt(elapsed time.Duration) (Look, bool) {
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed >= Duration {
		return Look{}, true
	}
	var l Look
	l.Alpha = 1
	l.Marker = 1
	if elapsed < popIn {
		p := float64(elapsed) / float64(popIn)
		l.Marker = easeOutBack(p)
		l.Alpha = p
	}
	if left := Duration - elapsed; left < fadeOut {
		l.Alpha = float64(left) / float64(fadeOut)
	}
	for i := range rings {
		start := time.Duration(i) * ringEvery
		t := elapsed - start
		if t < 0 || t >= ringLife {
			continue
		}
		p := float64(t) / float64(ringLife)
		l.Rings = append(l.Rings, Ring{
			Radius: ringMin + (ringMax-ringMin)*easeOutCubic(p),
			Alpha:  (1 - p) * l.Alpha,
		})
	}
	return l, false
}

func easeOutCubic(p float64) float64 { q := 1 - p; return 1 - q*q*q }

// easeOutBack overshoots a little, so the marker visibly pops.
func easeOutBack(p float64) float64 {
	const c1 = 1.70158
	const c3 = c1 + 1
	q := p - 1
	return 1 + c3*q*q*q + c1*q*q
}

// MaxPings caps the pings drawn at once; a newer one replaces the oldest. The room allows
// each viewer 4 a second (PROTOCOL.md §7.9), so this is only reached by a crowd.
const MaxPings = 12

// Pings is the set of running animations, keyed by an id the drawer chooses. It holds no
// surfaces, only the timing, so it is tested without a compositor.
type Pings struct {
	started map[uint32]time.Time
	order   []uint32
}

// Add starts a ping at now. It returns the id of the ping it pushed out, if any.
func (p *Pings) Add(id uint32, now time.Time) (evicted uint32, ok bool) {
	if p.started == nil {
		p.started = map[uint32]time.Time{}
	}
	if len(p.order) >= MaxPings {
		evicted, ok = p.order[0], true
		p.Remove(evicted)
	}
	p.started[id] = now
	p.order = append(p.order, id)
	return evicted, ok
}

// Remove forgets a ping.
func (p *Pings) Remove(id uint32) {
	if _, ok := p.started[id]; !ok {
		return
	}
	delete(p.started, id)
	for i, o := range p.order {
		if o == id {
			p.order = append(p.order[:i], p.order[i+1:]...)
			break
		}
	}
}

// Len is the number of running pings. The drawer only ticks while it is above zero.
func (p *Pings) Len() int { return len(p.order) }

// Frame is one running ping's look at now.
type Frame struct {
	ID   uint32
	Look Look
}

// Tick returns the look of every running ping at now and the ids of those that ended,
// which are removed.
func (p *Pings) Tick(now time.Time) (frames []Frame, ended []uint32) {
	for _, id := range append([]uint32(nil), p.order...) {
		look, done := LookAt(now.Sub(p.started[id]))
		if done {
			ended = append(ended, id)
			p.Remove(id)
			continue
		}
		frames = append(frames, Frame{ID: id, Look: look})
	}
	return frames, ended
}
