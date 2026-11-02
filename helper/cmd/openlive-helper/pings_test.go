// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"log/slog"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/compositor"
	"github.com/henriquefps/openlive/helper/internal/overlay"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

type pingCapture struct {
	placeable bool
	paused    bool
}

func (p *pingCapture) PingSource() (overlay.Source, compositor.Snapshot, bool) {
	snap := compositor.Snapshot{Outputs: []compositor.Output{{Name: "DP-1", Width: 1920, Height: 1080, Scale: 1}}}
	return overlay.Source{FrameW: 1920, FrameH: 1080, Output: "DP-1"}, snap, p.placeable
}
func (p *pingCapture) Paused() (bool, string) { return p.paused, "curtain" }

type countingDrawer struct{ shown []overlay.Spec }

func (d *countingDrawer) Show(s overlay.Spec) error { d.shown = append(d.shown, s); return nil }
func (d *countingDrawer) Close()                    {}

func TestNewPingsOnlyWhenDrawable(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	defer func(f func() bool) { overlaySupported = f }(overlaySupported)
	overlaySupported = func() bool { return true }
	capture := &pingCapture{placeable: true}
	target := func() (overlay.Target, bool) { return capture, true }
	if newPings(log, target) == nil {
		t.Error("no pings for a placeable capture on a desktop with the overlay")
	}
	if newPings(log, func() (overlay.Target, bool) { return nil, false }) != nil {
		t.Error("pings for a capture that is no ping target (macOS, the test source)")
	}
	capture.placeable = false
	if newPings(log, target) != nil {
		t.Error("pings for a capture without KWin")
	}
	capture.placeable = true
	overlaySupported = func() bool { return false }
	if newPings(log, target) != nil {
		t.Error("pings without the overlay (X11, no layer shell)")
	}
}

func TestLiveRoomDrawsPings(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	capture := &pingCapture{placeable: true}
	d := &countingDrawer{}
	opens := 0
	pings := overlay.NewController(log, func() (overlay.Target, bool) { return capture, true }).
		WithOpener(func(*slog.Logger) (overlay.Drawer, error) { opens++; return d, nil })
	l := &liveRoom{log: log, streamID: "s1", pings: pings}
	ping := &protocol.PointerPingedPayload{StreamID: "s1", UserID: "u2", Name: "Caio", X: 0.25, Y: 0.5,
		Style: protocol.PointerStyle{Color: protocol.PointerColorBlue, Shape: protocol.PointerShapeDot}}

	handle := func(p protocol.Payload) {
		t.Helper()
		if done, err := l.handle(p); done || err != nil {
			t.Fatalf("handle %T: done=%v err=%v", p, done, err)
		}
	}
	handle(ping) // pings are still off
	on, off := true, false
	handle(&protocol.StreamUpdatedPayload{Stream: protocol.StreamInfo{StreamID: "other", Pings: &on}})
	handle(ping)
	if opens != 0 || len(d.shown) != 0 {
		t.Fatalf("drawn before this stream allowed pings: opens %d, shown %d", opens, len(d.shown))
	}
	handle(&protocol.StreamUpdatedPayload{Stream: protocol.StreamInfo{StreamID: "s1", Pings: &on}})
	handle(ping)
	handle(&protocol.PointerPingedPayload{StreamID: "other", X: 0.5, Y: 0.5})
	if len(d.shown) != 1 || d.shown[0].Point.X != 480 || d.shown[0].Name != "Caio" {
		t.Fatalf("shown %+v", d.shown)
	}
	capture.paused = true
	handle(ping)
	if len(d.shown) != 1 {
		t.Error("drawn under the curtain")
	}
	capture.paused = false
	handle(&protocol.StreamUpdatedPayload{Stream: protocol.StreamInfo{StreamID: "s1", Pings: &off}})
	handle(ping)
	if len(d.shown) != 1 {
		t.Error("drawn after the streamer turned pings off")
	}
	if opens != 1 {
		t.Errorf("opened %d times", opens)
	}
}
