// SPDX-License-Identifier: AGPL-3.0-only

package media

import "time"

// FrameClock spaces the frames of one video layer on the RTP clock. A screen capture does
// not send frames at the nominal rate: a still screen, a Wayland capture that only sends
// damaged frames, videorate dropping frames or a capture restart leave gaps of any length.
// The RTP timestamps must follow those real gaps: a clock that advances by 1/fps per frame
// falls behind real time, the viewer reads the growing lag as jitter and its jitter buffer
// climbs to seconds while the audio stays on time.
//
// Gap returns how far the RTP clock must advance between the previous frame and this one.
// It is the PTS delta when the PTS is consistent with the wall clock (it keeps the exact
// spacing the capture saw, free of the encoder's latency jitter), and the wall-clock delta
// otherwise (a PTS that went back or jumped when the capture restarted, a missing PTS). In
// both cases the media time kept so far stays within FrameClockSlack of the wall-clock
// time since the layer's first frame, so the RTP clock tracks real time over any length of
// static screen, and one bogus PTS cannot make it jump ahead.
//
// A FrameClock is not safe for concurrent use; keep one per layer.
type FrameClock struct {
	started  bool
	start    time.Time     // wall-clock arrival of the first frame
	media    time.Duration // sum of the gaps so far
	lastPTS  time.Duration
	lastWall time.Time
	hasPTS   bool
}

// FrameClockSlack is how far the media time may drift from the wall-clock time since the
// first frame (encoder latency varies, a keyframe takes longer to encode).
const FrameClockSlack = 200 * time.Millisecond

// minFrameGap keeps two frames from sharing a timestamp.
const minFrameGap = time.Millisecond

// Gap returns the advance of the RTP clock before a frame with the given PTS (zero: none)
// that arrived at now. The first frame gets zero.
func (c *FrameClock) Gap(pts time.Duration, now time.Time) time.Duration {
	if !c.started {
		c.started = true
		c.start, c.lastWall = now, now
		c.lastPTS, c.hasPTS = pts, pts > 0
		return 0
	}
	wall := now.Sub(c.lastWall)
	gap := wall
	if pts > 0 && c.hasPTS {
		if d := pts - c.lastPTS; d > 0 && absDuration(d-wall) <= FrameClockSlack {
			gap = d
		}
	}
	// Keep the media time near the wall-clock time since the first frame.
	elapsed := now.Sub(c.start)
	gap = min(max(gap, elapsed-FrameClockSlack-c.media), elapsed+FrameClockSlack-c.media)
	gap = max(gap, minFrameGap)
	c.media += gap
	c.lastPTS, c.hasPTS = pts, pts > 0
	c.lastWall = now
	return gap
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
