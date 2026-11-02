// SPDX-License-Identifier: AGPL-3.0-only

package overlay

import (
	"errors"
	"log/slog"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/compositor"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

type fakeDrawer struct {
	shown  []Spec
	closed bool
	fail   bool
}

func (d *fakeDrawer) Show(s Spec) error {
	if d.fail {
		return errors.New("connection lost")
	}
	d.shown = append(d.shown, s)
	return nil
}
func (d *fakeDrawer) Close() { d.closed = true }

type fakeTarget struct {
	paused bool
	src    Source
	ok     bool
}

func (t *fakeTarget) PingSource() (Source, compositor.Snapshot, bool) {
	return t.src, compositor.Snapshot{Outputs: twoOutputs}, t.ok
}
func (t *fakeTarget) Paused() (bool, string) { return t.paused, "curtain" }

func newTestController(t *testing.T) (*Controller, *fakeTarget, *[]*fakeDrawer) {
	t.Helper()
	target := &fakeTarget{ok: true, src: Source{FrameW: 1920, FrameH: 1080, Output: "DP-1"}}
	c := NewController(slog.New(slog.DiscardHandler), func() (Target, bool) { return target, true })
	var drawers []*fakeDrawer
	c.open = func(*slog.Logger) (Drawer, error) {
		d := &fakeDrawer{}
		drawers = append(drawers, d)
		return d, nil
	}
	return c, target, &drawers
}

func ping(x, y float64) protocol.PointerPingedPayload {
	return protocol.PointerPingedPayload{StreamID: "s1", UserID: "u1", Name: "Bia", X: x, Y: y,
		Style: protocol.PointerStyle{Color: protocol.PointerColorPink, Shape: protocol.PointerShapeStar}}
}

func TestControllerFollowsPings(t *testing.T) {
	c, _, drawers := newTestController(t)
	if c.Ping(ping(0.5, 0.5)) {
		t.Error("drawn while pings are off")
	}
	if len(*drawers) != 0 {
		t.Fatal("a drawer opened while pings are off")
	}
	c.SetEnabled(true)
	if len(*drawers) != 1 {
		t.Fatal("no drawer while pings are on")
	}
	if !c.Ping(ping(0.5, 0.5)) {
		t.Fatal("not drawn")
	}
	d := (*drawers)[0]
	got := d.shown[0]
	if got.Name != "Bia" || got.Style.Shape != protocol.PointerShapeStar || got.Point.Output.Name != "DP-1" || got.Point.X != 960 || got.Point.Y != 540 {
		t.Errorf("shown %+v", got)
	}
	c.SetEnabled(false)
	if !d.closed {
		t.Error("the drawer stays open after pings were turned off")
	}
	c.SetEnabled(true)
	c.Close()
	if !(*drawers)[1].closed {
		t.Error("Close left the drawer open")
	}
	if c.Ping(ping(0.5, 0.5)) {
		t.Error("drawn after Close")
	}
}

func TestControllerDrops(t *testing.T) {
	c, target, drawers := newTestController(t)
	c.SetEnabled(true)
	target.paused = true
	if c.Ping(ping(0.5, 0.5)) {
		t.Error("drawn under the curtain")
	}
	target.paused = false
	if c.Ping(ping(1.5, 0.5)) {
		t.Error("drawn outside the frame")
	}
	target.ok = false
	if c.Ping(ping(0.5, 0.5)) {
		t.Error("drawn without a source")
	}
	if n := len((*drawers)[0].shown); n != 0 {
		t.Errorf("%d pings shown", n)
	}
}

func TestControllerReconnects(t *testing.T) {
	c, _, drawers := newTestController(t)
	c.SetEnabled(true)
	(*drawers)[0].fail = true
	if !c.Ping(ping(0.1, 0.1)) {
		t.Fatal("not drawn after the compositor dropped the connection")
	}
	if len(*drawers) != 2 || !(*drawers)[0].closed || len((*drawers)[1].shown) != 1 {
		t.Errorf("drawers %+v", *drawers)
	}
}

func TestControllerNoOverlay(t *testing.T) {
	c, _, _ := newTestController(t)
	c.open = func(*slog.Logger) (Drawer, error) { return nil, ErrNoLayerShell }
	c.SetEnabled(true)
	if c.Ping(ping(0.5, 0.5)) {
		t.Error("drawn without a drawer")
	}
}
