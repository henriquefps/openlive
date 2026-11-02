// SPDX-License-Identifier: AGPL-3.0-only

package notify

// NetworkWatch tells from the helper's per-second stats when the network is unstable:
// the congestion control cut the target bitrate well below what the stream reached, or
// packets are being lost, for long enough(a large
// or lasting reduction warns the streamer). Short dips are normal and stay quiet.
type NetworkWatch struct {
	// After is how many bad samples in a row make the network unstable, and how many
	// good ones make it stable again (default 10: ten seconds of stats).
	After int
	// CutRatio: a target below this share of the highest target seen is a cut (default 0.5).
	CutRatio float64
	// LossPct is the packet loss that counts as bad (default 5).
	LossPct float64

	peak     int
	bad      int
	good     int
	unstable bool
}

// Observe takes one sample; changed is true when the verdict flipped.
func (w *NetworkWatch) Observe(targetKbps int, lossPct float64) (unstable, changed bool) {
	after, ratio, loss := w.After, w.CutRatio, w.LossPct
	if after <= 0 {
		after = 10
	}
	if ratio <= 0 {
		ratio = 0.5
	}
	if loss <= 0 {
		loss = 5
	}
	if targetKbps > w.peak {
		w.peak = targetKbps
	}
	bad := lossPct >= loss || (w.peak > 0 && float64(targetKbps) < ratio*float64(w.peak))
	if bad {
		w.bad++
		w.good = 0
	} else {
		w.good++
		w.bad = 0
	}
	switch {
	case !w.unstable && w.bad >= after:
		w.unstable = true
		return true, true
	case w.unstable && w.good >= after:
		w.unstable = false
		return false, true
	}
	return w.unstable, false
}

// Reset forgets a stream that ended.
func (w *NetworkWatch) Reset() {
	*w = NetworkWatch{After: w.After, CutRatio: w.CutRatio, LossPct: w.LossPct}
}
