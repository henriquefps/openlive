// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"testing"
	"time"
)

// clockRun feeds one layer's frames to a FrameClock at wall-clock offsets from t0 and sums
// the gaps (the RTP clock's advance).
type clockRun struct {
	c     FrameClock
	t0    time.Time
	media time.Duration
}

func newClockRun() *clockRun { return &clockRun{t0: time.Unix(1000, 0)} }

func (r *clockRun) frame(t *testing.T, wall, pts time.Duration) time.Duration {
	t.Helper()
	g := r.c.Gap(pts, r.t0.Add(wall))
	if g < 0 {
		t.Fatalf("negative gap %s at %s", g, wall)
	}
	r.media += g
	return g
}

// rtpTicks is the 90 kHz advance a media time gives.
func rtpTicks(d time.Duration) int64 { return int64(d.Seconds() * 90000) }

func within(a, b, tol time.Duration) bool { return absDuration(a-b) <= tol }

func TestFrameClockSteadyRateFollowsPTS(t *testing.T) {
	r := newClockRun()
	step := time.Second / 60
	if g := r.frame(t, 0, time.Second); g != 0 {
		t.Fatalf("first frame gap %s, want 0", g)
	}
	for i := 1; i <= 600; i++ {
		// Arrival jitters by up to ±20 ms (encoder latency); the gap is the exact PTS step.
		jitter := time.Duration((i%5)-2) * 10 * time.Millisecond
		if g := r.frame(t, time.Duration(i)*step+jitter, time.Second+time.Duration(i)*step); g != step {
			t.Fatalf("frame %d gap %s, want %s", i, g, step)
		}
	}
	if !within(r.media, 10*time.Second, time.Millisecond) {
		t.Errorf("media %s after 10 s", r.media)
	}
}

// A still screen sends one frame now and then (videorate drop-only, damage-only capture):
// the RTP clock must still advance by the real time, not by 1/fps per frame.
func TestFrameClockStaticScreen(t *testing.T) {
	r := newClockRun()
	r.frame(t, 0, time.Second)
	// One frame every 3 s for 30 s, then a 30 s gap with nothing.
	for s := 3; s <= 30; s += 3 {
		d := time.Duration(s) * time.Second
		if g := r.frame(t, d+5*time.Millisecond, time.Second+d); g != 3*time.Second {
			t.Fatalf("gap %s at %ds, want 3s", g, s)
		}
	}
	if g := r.frame(t, 60*time.Second, 61*time.Second); g != 30*time.Second {
		t.Fatalf("gap after 30 s of still screen %s", g)
	}
	if got, want := rtpTicks(r.media), int64(60*90000); got != want {
		t.Errorf("RTP advanced %d ticks in 60 s, want %d", got, want)
	}
}

// After N seconds of wall time the RTP clock advanced ~N*90000, whatever the frame count
// and whatever the PTS does.
func TestFrameClockTracksWallClock(t *testing.T) {
	cases := map[string]func(i int, wall time.Duration) time.Duration{
		"pts":        func(_ int, wall time.Duration) time.Duration { return 5*time.Second + wall },
		"no pts":     func(int, time.Duration) time.Duration { return 0 },
		"slow pts":   func(_ int, wall time.Duration) time.Duration { return time.Second + wall/2 },
		"fast pts":   func(_ int, wall time.Duration) time.Duration { return time.Second + wall*3 },
		"stuck pts":  func(int, time.Duration) time.Duration { return 7 * time.Second },
		"pts resets": func(i int, wall time.Duration) time.Duration { return time.Duration(i%7+1) * time.Millisecond },
	}
	for name, ptsAt := range cases {
		t.Run(name, func(t *testing.T) {
			r := newClockRun()
			// Irregular frames: bursts at 60 fps and pauses of up to 4 s, for 120 s.
			wall, i := time.Duration(0), 0
			var last time.Duration
			for wall < 120*time.Second {
				r.frame(t, wall, ptsAt(i, wall))
				last = wall
				if !within(r.media, wall, FrameClockSlack) {
					t.Fatalf("media %s at wall %s (frame %d)", r.media, wall, i)
				}
				i++
				if i%50 < 40 {
					wall += time.Second / 60
				} else {
					wall += time.Duration(i%4+1) * time.Second
				}
			}
			if got, want := rtpTicks(r.media), rtpTicks(last); got < want-rtpTicks(FrameClockSlack) || got > want+rtpTicks(FrameClockSlack) {
				t.Errorf("RTP advanced %d ticks in %s, want ~%d (%d frames)", got, last, want, i)
			}
		})
	}
}

// A capture restart (resize, source change) starts a new PTS base after a pause.
func TestFrameClockCaptureRestart(t *testing.T) {
	r := newClockRun()
	step := time.Second / 60
	for i := 0; i <= 120; i++ {
		r.frame(t, time.Duration(i)*step, 40*time.Second+time.Duration(i)*step)
	}
	// 1.5 s without frames, then the PTS starts over near zero.
	resume := 2*time.Second + 1500*time.Millisecond
	if g := r.frame(t, resume, 30*time.Millisecond); !within(g, 1500*time.Millisecond, time.Millisecond) {
		t.Fatalf("gap across the restart %s, want the 1.5 s of wall time", g)
	}
	for i := 1; i <= 60; i++ {
		if g := r.frame(t, resume+time.Duration(i)*step, 30*time.Millisecond+time.Duration(i)*step); g != step {
			t.Fatalf("frame %d after the restart: gap %s, want %s", i, g, step)
		}
	}
	if !within(r.media, resume+time.Second, time.Millisecond) {
		t.Errorf("media %s, want %s", r.media, resume+time.Second)
	}
	// A PTS that jumps far ahead is ignored: the clock does not leap.
	before := r.media
	if g := r.frame(t, resume+time.Second+step, time.Hour); g > step+time.Millisecond {
		t.Errorf("PTS jump moved the clock by %s", g)
	}
	if r.media-before > FrameClockSlack {
		t.Errorf("clock jumped %s", r.media-before)
	}
}

// Each layer has its own clock: a layer that starts late starts at zero, and its timeline
// is real time from its own first frame.
func TestFrameClockLateLayer(t *testing.T) {
	f, q := newClockRun(), newClockRun()
	step := time.Second / 30
	var qStart time.Duration
	for i := 0; i <= 300; i++ {
		wall := time.Duration(i) * step
		f.frame(t, wall, time.Second+wall)
		if i >= 120 {
			if i == 120 {
				qStart = wall
			}
			if g := q.frame(t, wall, time.Second+wall); i == 120 && g != 0 {
				t.Fatalf("late layer's first gap %s, want 0", g)
			}
		}
	}
	if !within(f.media, 10*time.Second, time.Millisecond) || !within(q.media, 10*time.Second-qStart, time.Millisecond) {
		t.Errorf("media f %s q %s, want 10s and %s", f.media, q.media, 10*time.Second-qStart)
	}
}

// Two frames with the same PTS still get distinct timestamps.
func TestFrameClockDuplicatePTS(t *testing.T) {
	r := newClockRun()
	r.frame(t, 0, time.Second)
	if g := r.frame(t, 0, time.Second); g < minFrameGap {
		t.Errorf("gap %s for a duplicate PTS", g)
	}
}
