// SPDX-License-Identifier: AGPL-3.0-only

package rtc

import (
	"time"

	"github.com/henriquefps/openlive/helper/internal/media"
)

// RateConfig tunes RateController. The zero value of a field means its default.
type RateConfig struct {
	MinKbps, MaxKbps int
	// Headroom is the share of the estimate given to the encoders (room for RTP
	// overhead, retransmissions and IDR bursts).
	Headroom float64
	// Up: the wanted rate must stay UpThreshold above the target for UpHold, and then
	// rises by at most UpStep per change, so a noisy estimate does not make the
	// encoders oscillate. Down: as soon as it is DownThreshold below.
	UpHold        time.Duration
	UpStep        float64
	UpThreshold   float64
	DownThreshold float64

	// Watchdog (Phase 0 risk 1: pion's GCC can stop updating under a deep queue with
	// NACK): when receiver-reported loss stays at or above LossHigh for WatchdogHold
	// while the estimate moves by less than WatchdogStill, cap the target at
	// WatchdogCut of itself. The cap relaxes by UpStep every WatchdogHold once loss is
	// below LossLow, and goes away when the estimate is below it again.
	LossHigh      float64
	LossLow       float64
	WatchdogHold  time.Duration
	WatchdogStill float64
	WatchdogCut   float64
}

func (c RateConfig) withDefaults() RateConfig {
	def := func(v *float64, d float64) {
		if *v == 0 {
			*v = d
		}
	}
	def(&c.Headroom, 0.85)
	def(&c.UpStep, 1.25)
	def(&c.UpThreshold, 1.1)
	def(&c.DownThreshold, 0.9)
	def(&c.LossHigh, 0.05)
	def(&c.LossLow, 0.02)
	def(&c.WatchdogStill, 0.05)
	def(&c.WatchdogCut, 0.75)
	if c.UpHold == 0 {
		c.UpHold = 2 * time.Second
	}
	if c.WatchdogHold == 0 {
		c.WatchdogHold = 2 * time.Second
	}
	return c
}

// Decision is what one RateController step decided.
type Decision struct {
	Kbps    int
	Changed bool
	// Reason is "up", "down", "watchdog" or "" when nothing changed.
	Reason string
}

// RateController maps the GCC estimate and receiver-reported loss to the total encoder
// bitrate. It is a pure state machine: the caller passes the time, so
// tests drive it without sleeping.
type RateController struct {
	cfg    RateConfig
	target int // kbit/s

	aboveSince time.Time

	lossSince   time.Time // start of the current high-loss window
	lossRefBps  int       // estimate at the start of that window
	ceiling     int       // watchdog cap in kbit/s; 0 = none
	lastCut     time.Time
	lastRelaxed time.Time
}

// NewRateController starts at startKbps.
func NewRateController(cfg RateConfig, startKbps int) *RateController {
	cfg = cfg.withDefaults()
	return &RateController{cfg: cfg, target: clamp(startKbps, cfg.MinKbps, cfg.MaxKbps)}
}

// Target is the current total bitrate in kbit/s.
func (r *RateController) Target() int { return r.target }

// Ceiling is the watchdog cap in kbit/s, 0 when there is none.
func (r *RateController) Ceiling() int { return r.ceiling }

// Reset takes a new bitrate budget (a preset change: other layers, other sums) and
// restarts at startKbps, never above what the last estimate allows (estimateBps; 0 when
// there is none yet) nor above the watchdog's cap, which describes the network and so
// survives the change.
func (r *RateController) Reset(minKbps, maxKbps, startKbps, estimateBps int) {
	r.cfg.MinKbps, r.cfg.MaxKbps = minKbps, maxKbps
	if estimateBps > 0 {
		startKbps = min(startKbps, r.Want(estimateBps))
	}
	if r.ceiling > 0 {
		r.ceiling = clamp(r.ceiling, minKbps, maxKbps)
		startKbps = min(startKbps, r.ceiling)
	}
	r.target = clamp(round100(startKbps), minKbps, maxKbps)
	r.aboveSince = time.Time{}
}

// Want is the total the estimate allows, before hysteresis and the watchdog.
func (r *RateController) Want(estimateBps int) int {
	return clamp(int(float64(estimateBps)/1000*r.cfg.Headroom), r.cfg.MinKbps, r.cfg.MaxKbps)
}

// Step takes the GCC estimate (bit/s) and the latest loss fraction (0–1).
func (r *RateController) Step(now time.Time, estimateBps int, loss float64) Decision {
	cfg := r.cfg
	want := r.Want(estimateBps)

	if d, ok := r.watchdog(now, estimateBps, loss, want); ok {
		return d
	}
	if r.ceiling > 0 {
		want = min(want, r.ceiling)
	}

	cur := r.target
	switch {
	case float64(want) < float64(cur)*cfg.DownThreshold:
		r.aboveSince = time.Time{}
		return r.set(want, "down")
	case float64(want) > float64(cur)*cfg.UpThreshold:
		if r.aboveSince.IsZero() {
			r.aboveSince = now
		}
		if now.Sub(r.aboveSince) >= cfg.UpHold {
			r.aboveSince = now
			return r.set(min(want, int(float64(cur)*cfg.UpStep)), "up")
		}
	default:
		r.aboveSince = time.Time{}
	}
	return Decision{Kbps: r.target}
}

// watchdog updates the loss window and the cap; it returns a decision when it cut.
func (r *RateController) watchdog(now time.Time, estimateBps int, loss float64, want int) (Decision, bool) {
	cfg := r.cfg
	if loss >= cfg.LossHigh {
		moved := r.lossRefBps > 0 && abs(estimateBps-r.lossRefBps) > int(float64(r.lossRefBps)*cfg.WatchdogStill)
		if r.lossSince.IsZero() || moved {
			// A new loss window, or GCC is reacting: give it a full window.
			r.lossSince, r.lossRefBps = now, estimateBps
		} else if now.Sub(r.lossSince) >= cfg.WatchdogHold && now.Sub(r.lastCut) >= cfg.WatchdogHold {
			r.ceiling = max(cfg.MinKbps, int(float64(r.target)*cfg.WatchdogCut))
			r.lastCut, r.lastRelaxed = now, now
			r.lossSince, r.lossRefBps = now, estimateBps
			r.aboveSince = time.Time{}
			return r.set(r.ceiling, "watchdog"), true
		}
		return Decision{}, false
	}
	r.lossSince, r.lossRefBps = time.Time{}, 0
	if r.ceiling > 0 && loss < cfg.LossLow && now.Sub(r.lastRelaxed) >= cfg.WatchdogHold {
		r.lastRelaxed = now
		r.ceiling = int(float64(r.ceiling) * cfg.UpStep)
		if r.ceiling >= want || r.ceiling >= cfg.MaxKbps {
			r.ceiling = 0
		}
	}
	return Decision{}, false
}

func (r *RateController) set(kbps int, reason string) Decision {
	kbps = clamp(round100(kbps), r.cfg.MinKbps, r.cfg.MaxKbps)
	if kbps == r.target {
		return Decision{Kbps: kbps}
	}
	r.target = kbps
	return Decision{Kbps: kbps, Changed: true, Reason: reason}
}

// Allocate splits a total bitrate over simulcast layers (highest first). With an AV1
// track beside the H.264 one, each track first gets the share of its targets (the AV1
// track ~65/165), so a cut lowers both top layers alike. Within a track every layer gets
// its minimum; what is left fills the layers from the lowest up to their targets, so
// viewers on the low layers keep a good picture and the top layer absorbs the cut.
func Allocate(totalKbps int, layers []media.Layer) []int {
	out := make([]int, len(layers))
	tracks := map[media.Codec][]int{}
	var codecs []media.Codec
	for i, l := range layers {
		c := l.VideoCodec()
		if _, ok := tracks[c]; !ok {
			codecs = append(codecs, c)
		}
		tracks[c] = append(tracks[c], i)
	}
	all, _ := SumTargets(layers)
	left := totalKbps
	for n, c := range codecs {
		idx := tracks[c]
		track := make([]media.Layer, len(idx))
		for k, i := range idx {
			track[k] = layers[i]
		}
		share := left
		if n < len(codecs)-1 && all > 0 {
			target, _ := SumTargets(track)
			share = totalKbps * target / all
		}
		left -= share
		for k, kbps := range allocateTrack(share, track) {
			out[idx[k]] = kbps
		}
	}
	return out
}

// allocateTrack gives every layer of one track its minimum, then fills q, h, f up to
// their targets.
func allocateTrack(totalKbps int, layers []media.Layer) []int {
	out := make([]int, len(layers))
	left := totalKbps
	for i, l := range layers {
		out[i] = l.MinKbps
		left -= l.MinKbps
	}
	for i := len(layers) - 1; i >= 0 && left > 0; i-- {
		add := min(left, layers[i].Kbps-out[i])
		out[i] += add
		left -= add
	}
	return out
}

// SumTargets is the total of the layers' target bitrates.
func SumTargets(layers []media.Layer) (target, minimum int) {
	for _, l := range layers {
		target += l.Kbps
		minimum += l.MinKbps
	}
	return target, minimum
}

func clamp(v, lo, hi int) int {
	if hi > 0 {
		v = min(v, hi)
	}
	return max(lo, v)
}

func round100(v int) int { return (v + 50) / 100 * 100 }

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
