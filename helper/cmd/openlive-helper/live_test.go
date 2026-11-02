// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"sync"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/rtc"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// chanStream is a media.Stream fed by the test.
type chanStream struct {
	video chan media.EncodedFrame
	err   chan error

	mu        sync.Mutex
	keyframes []string
	stopped   bool
}

func newChanStream() *chanStream {
	return &chanStream{video: make(chan media.EncodedFrame, 8), err: make(chan error, 1)}
}

func (s *chanStream) Video() <-chan media.EncodedFrame { return s.video }
func (s *chanStream) Audio() <-chan media.EncodedFrame { return nil }
func (s *chanStream) SetBitrate(string, int) error     { return nil }
func (s *chanStream) Err() <-chan error                { return s.err }
func (s *chanStream) RequestKeyframe(rid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keyframes = append(s.keyframes, rid)
	return nil
}
func (s *chanStream) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopped = true
	return nil
}

func receive(t *testing.T, g *gatedStream) (media.EncodedFrame, bool) {
	t.Helper()
	select {
	case f := <-g.Video():
		return f, true
	case <-time.After(100 * time.Millisecond):
		return media.EncodedFrame{}, false
	}
}

func TestGatedStreamCurtainAndSwap(t *testing.T) {
	layers := []media.Layer{{RID: "f"}, {RID: "q"}}
	first := newChanStream()
	g := newGatedStream(first, layers, false)
	if g.Audio() != nil {
		t.Fatal("audio without audio")
	}
	first.video <- media.EncodedFrame{RID: "f", Data: []byte{1}}
	if f, ok := receive(t, g); !ok || f.Data[0] != 1 {
		t.Fatalf("frame = %+v %v", f, ok)
	}

	// The curtain drops frames; lifting it asks every layer for a keyframe.
	g.SetPaused(true)
	first.video <- media.EncodedFrame{RID: "f", Data: []byte{2}}
	if f, ok := receive(t, g); ok {
		t.Fatalf("frame through the curtain: %+v", f)
	}
	first.mu.Lock()
	first.keyframes = nil
	first.mu.Unlock()
	g.SetPaused(false)
	first.mu.Lock()
	if len(first.keyframes) != 2 {
		t.Fatalf("keyframes after the curtain = %v", first.keyframes)
	}
	first.mu.Unlock()

	// A preset change swaps the capture: the old one stops, frames come from the new one.
	second := newChanStream()
	g.Swap(second, layers)
	first.mu.Lock()
	if !first.stopped {
		t.Fatal("the old capture still runs")
	}
	first.mu.Unlock()
	second.video <- media.EncodedFrame{RID: "f", Data: []byte{3}}
	if f, ok := receive(t, g); !ok || f.Data[0] != 3 {
		t.Fatalf("frame after swap = %+v %v", f, ok)
	}
	if err := g.Stop(); err != nil || !second.stopped {
		t.Fatalf("stop: %v %v", err, second.stopped)
	}
	// After Stop the publisher's late calls are harmless.
	if err := g.RequestKeyframe("f"); err != nil {
		t.Fatal(err)
	}
}

func TestEstimateMaxKbps(t *testing.T) {
	all := protocol.RoomSettings{AllowedPresets: []protocol.Preset{protocol.PresetText, protocol.PresetGame, protocol.PresetMax}}
	// 1440p60 is the largest: 12000 + 3500 + 1000, × 1.5.
	if got := estimateMaxKbps(all, media.AllRIDs); got != 24750 {
		t.Fatalf("got %d, want 24750", got)
	}
	all.MaxBitrateKbps = 10000
	if got := estimateMaxKbps(all, media.AllRIDs); got != 15000 {
		t.Fatalf("under a 10000 cap got %d, want 15000", got)
	}
	// With the 120 fps presets allowed, GCC may probe for 1440p120: 20000 + 3500 + 1000, × 1.5.
	fast := protocol.RoomSettings{AllowedPresets: []protocol.Preset{protocol.PresetGame, protocol.PresetMax, protocol.PresetGame120, protocol.PresetMax120}}
	if got := estimateMaxKbps(fast, media.AllRIDs); got != 36750 {
		t.Fatalf("with 1440p120 got %d, want 36750", got)
	}
}

// The room's 13 Mbit/s default caps a 120 fps preset: the top layer gets what is left
// after h, q and the audio, which fitRoom reports to the rate controller.
func TestFitRoom120(t *testing.T) {
	p := mustPreset(t, "1440p120")
	layers, _ := p.Layers(media.AllRIDs)
	settings := protocol.RoomSettings{MaxBitrateKbps: 13000, AllowedPresets: []protocol.Preset{protocol.PresetMax120}}
	var cfg rtc.Config
	total, err := fitRoom(settings, p, layers, true, &cfg)
	if err != nil {
		t.Fatal(err)
	}
	if total != 13000 || cfg.Rate.MaxKbps != 13000-audioKbps {
		t.Fatalf("total %d, video cap %d", total, cfg.Rate.MaxKbps)
	}
	settings.MaxBitrateKbps = 25000
	cfg = rtc.Config{}
	if total, _ := fitRoom(settings, p, layers, true, &cfg); total != 20000+3500+1000+audioKbps || cfg.Rate.MaxKbps != 0 {
		t.Fatalf("uncapped: total %d, cap %d", total, cfg.Rate.MaxKbps)
	}
	settings.AllowedPresets = []protocol.Preset{protocol.PresetMax}
	if _, err := fitRoom(settings, p, layers, true, &cfg); err == nil {
		t.Fatal("a room without max120 accepted it")
	}
}

// slowStopStream is a capture whose Stop takes a while, like an encoder draining.
type slowStopStream struct {
	*chanStream
	release chan struct{}
}

func (s *slowStopStream) Stop() error {
	<-s.release
	return s.chanStream.Stop()
}

// TestGatedStreamSwapWaitsForTheOldCapture: Swap returns only once the old capture is down
// (its encoders drained), and then forwards the new one's frames. switchTo holds
// s.switching around Swap, so the next preset change can never tear down or build a
// pipeline while the previous teardown runs.
func TestGatedStreamSwapWaitsForTheOldCapture(t *testing.T) {
	layers := []media.Layer{{RID: "f"}}
	first := &slowStopStream{chanStream: newChanStream(), release: make(chan struct{})}
	g := newGatedStream(first, layers, false)
	second := newChanStream()
	swapped := make(chan struct{})
	go func() {
		g.Swap(second, layers)
		close(swapped)
	}()
	select {
	case <-swapped:
		t.Fatal("Swap returned before the old capture stopped")
	case <-time.After(50 * time.Millisecond):
	}
	close(first.release)
	select {
	case <-swapped:
	case <-time.After(time.Second):
		t.Fatal("Swap did not return after the old capture stopped")
	}
	first.mu.Lock()
	stopped := first.stopped
	first.mu.Unlock()
	if !stopped {
		t.Fatal("the old capture still runs")
	}
	second.video <- media.EncodedFrame{RID: "f", Data: []byte{7}}
	if f, ok := receive(t, g); !ok || f.Data[0] != 7 {
		t.Fatalf("frame after swap = %+v %v", f, ok)
	}
	_ = g.Stop()
}
