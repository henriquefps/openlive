// SPDX-License-Identifier: AGPL-3.0-only

package rtc

import (
	"reflect"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/media"
)

var t0 = time.Unix(1_000_000, 0)

func at(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }

func newTestController() *RateController {
	return NewRateController(RateConfig{MinKbps: 1000, MaxKbps: 10000}, 10000)
}

func TestRateDownAtOnce(t *testing.T) {
	r := newTestController()
	// 8 Mbit/s estimate * 0.85 headroom = 6800 kbit/s, more than 10% below 10000.
	d := r.Step(at(0), 8_000_000, 0)
	if !d.Changed || d.Reason != "down" || d.Kbps != 6800 {
		t.Fatalf("got %+v, want down to 6800", d)
	}
	// Within 10% of the target: no change.
	if d := r.Step(at(100), 7_600_000, 0); d.Changed {
		t.Fatalf("small move changed the target: %+v", d)
	}
}

func TestRateUpWithHysteresis(t *testing.T) {
	r := NewRateController(RateConfig{MinKbps: 1000, MaxKbps: 10000}, 4000)
	// The estimate allows 8500; the target only rises after 2 s above, by at most 25%.
	for ms := 0; ms < 2000; ms += 100 {
		if d := r.Step(at(ms), 10_000_000, 0); d.Changed {
			t.Fatalf("rose before the hold at %d ms: %+v", ms, d)
		}
	}
	d := r.Step(at(2000), 10_000_000, 0)
	if !d.Changed || d.Reason != "up" || d.Kbps != 5000 {
		t.Fatalf("got %+v, want up to 5000", d)
	}
	// A dip below the threshold resets the hold.
	r.Step(at(2100), 5_500_000, 0)
	for ms := 2200; ms < 4200; ms += 100 {
		if d := r.Step(at(ms), 10_000_000, 0); d.Changed {
			t.Fatalf("rose before a new hold at %d ms: %+v", ms, d)
		}
	}
	if d := r.Step(at(4200), 10_000_000, 0); d.Kbps != 6300 {
		t.Fatalf("got %+v, want up to 6300 (5000 * 1.25, rounded)", d)
	}
}

func TestRateClamped(t *testing.T) {
	r := newTestController()
	if d := r.Step(at(0), 100_000, 0); d.Kbps != 1000 {
		t.Fatalf("got %+v, want the 1000 minimum", d)
	}
}

func TestWatchdogCutsWhenEstimateIsStuck(t *testing.T) {
	r := newTestController()
	// GCC keeps saying 12 Mbit/s (above the max) while receivers report 10% loss.
	var cut Decision
	for ms := 0; ms <= 2000; ms += 100 {
		d := r.Step(at(ms), 12_000_000, 0.10)
		if d.Changed {
			cut = d
			if ms < 2000 {
				t.Fatalf("watchdog cut early at %d ms", ms)
			}
		}
	}
	if cut.Reason != "watchdog" || cut.Kbps != 7500 {
		t.Fatalf("got %+v, want a watchdog cut to 7500", cut)
	}
	if r.Ceiling() != 7500 {
		t.Fatalf("ceiling %d, want 7500", r.Ceiling())
	}
	// Loss goes on: another cut one hold later, not before.
	for ms := 2100; ms < 4000; ms += 100 {
		if d := r.Step(at(ms), 12_000_000, 0.10); d.Changed {
			t.Fatalf("second cut too early at %d ms: %+v", ms, d)
		}
	}
	if d := r.Step(at(4000), 12_000_000, 0.10); d.Reason != "watchdog" || d.Kbps != 5600 {
		t.Fatalf("got %+v, want a second cut to 5600", d)
	}
	// The estimate is high but the cap holds the target.
	if d := r.Step(at(4100), 12_000_000, 0); d.Changed {
		t.Fatalf("target rose through the cap: %+v", d)
	}
	// Loss clears: the cap relaxes by 25% every 2 s and the target follows with hysteresis.
	var last Decision
	for ms := 4200; ms <= 20000; ms += 100 {
		if d := r.Step(at(ms), 12_000_000, 0); d.Changed {
			last = d
		}
	}
	if r.Ceiling() != 0 || last.Kbps != 10000 {
		t.Fatalf("after recovery: ceiling %d, last %+v; want no ceiling and 10000", r.Ceiling(), last)
	}
}

func TestWatchdogLeavesAMovingEstimateToGCC(t *testing.T) {
	r := newTestController()
	// Loss, but GCC reacts: the estimate keeps falling by more than 5% per window.
	bps := 12_000_000
	for ms := 0; ms <= 6000; ms += 100 {
		if ms%1000 == 0 {
			bps = bps * 90 / 100
		}
		if d := r.Step(at(ms), bps, 0.10); d.Reason == "watchdog" {
			t.Fatalf("watchdog fired at %d ms although GCC is moving", ms)
		}
	}
	if r.Ceiling() != 0 {
		t.Fatalf("ceiling %d, want none", r.Ceiling())
	}
}

func TestWatchdogIgnoresShortLoss(t *testing.T) {
	r := newTestController()
	for ms := 0; ms < 1500; ms += 100 {
		r.Step(at(ms), 12_000_000, 0.20)
	}
	for ms := 1500; ms < 5000; ms += 100 {
		if d := r.Step(at(ms), 12_000_000, 0.01); d.Changed {
			t.Fatalf("short loss burst changed the target: %+v", d)
		}
	}
}

func TestAllocate(t *testing.T) {
	p, _ := media.FindPreset("1080p60")
	layers, _ := p.Layers(media.AllRIDs) // f 8000 (min 2000), h 3500 (1000), q 1000 (300)
	cases := []struct {
		total int
		want  []int
	}{
		{12500, []int{8000, 3500, 1000}},
		{20000, []int{8000, 3500, 1000}},
		{8000, []int{3500, 3500, 1000}},
		{5000, []int{2000, 2000, 1000}},
		{4000, []int{2000, 1000, 1000}},
		{1000, []int{2000, 1000, 300}},
	}
	for _, c := range cases {
		if got := Allocate(c.total, layers); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Allocate(%d) = %v, want %v", c.total, got, c.want)
		}
	}
}

// TestAllocateWithAV1: the AV1 track (the top layer at 65 %) gets its share of the total
// first, so a cut lowers both top layers instead of the H.264 one alone.
func TestAllocateWithAV1(t *testing.T) {
	p, _ := media.FindPreset("1080p60")
	h264, _ := p.Layers(media.AllRIDs)
	layers := media.WithAV1(h264, media.AV1SavePercent) // + af 5200 (min 1300): 17700 in all
	cases := []struct {
		total int
		want  []int
	}{
		{17700, []int{8000, 3500, 1000, 5200}},
		{30000, []int{8000, 3500, 1000, 5200}},
		// 12500/17700 of 8850 is 6250 for H.264, the rest (2600) for AV1.
		{8850, []int{2000, 3250, 1000, 2600}},
		// Below the minimums every layer keeps its own.
		{1000, []int{2000, 1000, 300, 1300}},
	}
	for _, c := range cases {
		if got := Allocate(c.total, layers); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Allocate(%d) = %v, want %v", c.total, got, c.want)
		}
	}
}

// TestAllocateWithAV1Quality: in the quality mode the AV1 top layer has the
// H.264 one's target, so it takes a larger share of the total.
func TestAllocateWithAV1Quality(t *testing.T) {
	p, _ := media.FindPreset("1080p60")
	h264, _ := p.Layers(media.AllRIDs)
	layers := media.WithAV1(h264, media.AV1QualityPercent) // + af 8000 (min 2000): 20500 in all
	cases := []struct {
		total int
		want  []int
	}{
		{20500, []int{8000, 3500, 1000, 8000}},
		// 12500/20500 of 10250 is 6250 for H.264, the rest (4000) for AV1.
		{10250, []int{2000, 3250, 1000, 4000}},
		{1000, []int{2000, 1000, 300, 2000}},
	}
	for _, c := range cases {
		if got := Allocate(c.total, layers); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Allocate(%d) = %v, want %v", c.total, got, c.want)
		}
	}
}

// TestRateResetTakesTheNewBudget: a preset change while live gives the controller the new
// layers' sums. Without it, 1080p30 → 1440p60 stayed capped at 1080p30's 10500 kbit/s.
func TestRateResetTakesTheNewBudget(t *testing.T) {
	text, _ := media.FindPreset("1080p30")
	maxP, _ := media.FindPreset("1440p60")
	from, _ := text.Layers(media.AllRIDs)
	to, _ := maxP.Layers(media.AllRIDs)
	fromMax, fromMin := SumTargets(from)
	toMax, toMin := SumTargets(to)
	r := NewRateController(RateConfig{MinKbps: fromMin, MaxKbps: fromMax}, fromMax)

	r.Reset(toMin, toMax, toMax, 0)
	if r.Target() != toMax {
		t.Fatalf("target %d after the reset, want the new sum %d", r.Target(), toMax)
	}
	// A 25 Mbit/s estimate allows the whole new budget: no cut back to the old one.
	if d := r.Step(at(0), 25_000_000, 0); d.Changed || d.Kbps != toMax {
		t.Fatalf("got %+v, want %d unchanged", d, toMax)
	}
	// The old budget's minimum no longer holds: the new one's does.
	if d := r.Step(at(100), 1_000_000, 0); d.Kbps != toMin {
		t.Fatalf("got %+v, want the new minimum %d", d, toMin)
	}

	// The start never exceeds what the last estimate allows (12 Mbit/s * 0.85).
	r.Reset(toMin, toMax, toMax, 12_000_000)
	if r.Target() != 10200 {
		t.Fatalf("target %d, want 10200", r.Target())
	}
}

func TestRateResetKeepsTheWatchdogCap(t *testing.T) {
	r := newTestController()
	// Stuck estimate under 10% loss: the watchdog caps at 7500.
	for ms := 0; ms <= 2000; ms += 100 {
		r.Step(at(ms), 12_000_000, 0.1)
	}
	if r.Ceiling() != 7500 {
		t.Fatalf("ceiling %d, want 7500", r.Ceiling())
	}
	r.Reset(2000, 20000, 20000, 0)
	if r.Target() != 7500 || r.Ceiling() != 7500 {
		t.Fatalf("target %d ceiling %d after the reset, want both at the cap 7500", r.Target(), r.Ceiling())
	}
}
