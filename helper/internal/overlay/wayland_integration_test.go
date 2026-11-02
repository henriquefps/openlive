// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration && linux

package overlay

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/henriquefps/openlive/helper/internal/compositor"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// TestShowOnDesktop draws a ping on the real session: go test -tags integration ./internal/overlay/
func TestShowOnDesktop(t *testing.T) {
	if s := Probe(); !s.OK() {
		t.Skipf("no overlay: %v", s.Err)
	}
	d, err := Open(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	out := firstOutput(t)
	err = d.Show(Spec{Point: Point{Output: out, X: float64(out.Width) / 2, Y: float64(out.Height) / 2},
		Name: "Integration test", Style: protocol.PointerStyle{Color: protocol.PointerColorCyan, Shape: protocol.PointerShapeStar}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(Duration + 200*time.Millisecond)
	if err := d.Show(Spec{Point: Point{Output: out, X: 10, Y: 10}, Name: "corner"}); err != nil {
		t.Fatalf("the drawer died during the animation: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
}

// TestInputGoesThrough checks the click-through without injecting any input: a layer
// surface over the whole output gets wl_pointer.enter wherever the pointer is, unless
// its input region is empty, as the pings' is. The control (a default input region)
// shows that the compositor does send enter to a surface mapped under a still pointer;
// without it the test is inconclusive and skips.
func TestInputGoesThrough(t *testing.T) {
	if s := Probe(); !s.OK() {
		t.Skipf("no overlay: %v", s.Err)
	}
	control, err := pointerEnters(false)
	if err != nil {
		t.Fatal(err)
	}
	if !control {
		t.Skip("the compositor sent no wl_pointer.enter to a surface mapped under the pointer (no pointer on this seat?): inconclusive")
	}
	empty, err := pointerEnters(true)
	if err != nil {
		t.Fatal(err)
	}
	if empty {
		t.Fatal("a surface with an empty input region received the pointer")
	}
	t.Log("the control surface got wl_pointer.enter; the one with the pings' empty input region did not")
}

func firstOutput(t *testing.T) compositor.Output {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// A name of its own keeps a running helper's watch script loaded.
	k, err := compositor.WatchKWinAs(ctx, "openlive-helper-overlay-itest")
	if err != nil {
		t.Skipf("no KWin: %v", err)
	}
	defer k.Close()
	outs := k.Snapshot().Outputs
	if len(outs) == 0 {
		t.Skip("KWin lists no output")
	}
	t.Logf("output %+v", outs[0])
	return outs[0]
}

// pointerEnters maps a transparent full-output overlay surface for a moment and reports
// whether the pointer entered it.
func pointerEnters(emptyInput bool) (bool, error) {
	h, err := connect()
	if err != nil {
		return false, err
	}
	c := h.c
	defer func() { _ = c.close() }()
	ids := map[string]uint32{}
	for _, b := range []struct {
		iface string
		max   uint32
	}{{ifCompositor, 4}, {ifShm, 1}, {ifLayerShell, 4}, {ifViewporter, 1}, {"wl_seat", 5}} {
		g, ok := h.find(b.iface)
		if !ok {
			return false, errors.New("missing " + b.iface)
		}
		if ids[b.iface], err = h.bind(g, b.max); err != nil {
			return false, err
		}
	}
	send := func(obj uint32, op uint16, m *msg) {
		if err == nil {
			err = c.send(obj, op, m)
		}
	}
	pointer := c.newID()
	send(ids["wl_seat"], 0, new(msg).u32(pointer)) // wl_seat.get_pointer

	// One transparent pixel, stretched over the output by the viewport.
	fd, ferr := unix.MemfdCreate("openlive-itest", unix.MFD_CLOEXEC)
	if ferr != nil {
		return false, ferr
	}
	defer func() { _ = unix.Close(fd) }()
	if err := unix.Ftruncate(fd, 4); err != nil {
		return false, err
	}
	pool := c.newID()
	send(ids[ifShm], shmCreatePool, new(msg).u32(pool).fd(fd).i32(4))
	buffer := c.newID()
	send(pool, poolCreateBuffer, new(msg).u32(buffer).i32(0).i32(1).i32(1).i32(4).u32(shmFormatARGB))
	surface := c.newID()
	send(ids[ifCompositor], compositorCreateSurface, new(msg).u32(surface))
	if emptyInput {
		region := c.newID()
		send(ids[ifCompositor], compositorCreateRegion, new(msg).u32(region))
		send(surface, surfaceSetInputRegion, new(msg).u32(region))
	}
	viewport := c.newID()
	send(ids[ifViewporter], viewporterGetViewport, new(msg).u32(viewport).u32(surface))
	layer := c.newID()
	send(ids[ifLayerShell], layerShellGetLayerSurface, new(msg).u32(layer).u32(surface).u32(0).u32(layerOverlay).str("openlive-itest"))
	send(layer, layerSurfaceSetAnchor, new(msg).u32(15)) // every edge: the output's size
	send(layer, layerSurfaceSetExclusiveZone, new(msg).i32(-1))
	send(layer, layerSurfaceSetKeyboard, new(msg).u32(0))
	send(surface, surfaceCommit, nil)
	if err != nil {
		return false, err
	}
	deadline := time.Now().Add(3 * time.Second)
	mapped := time.Time{}
	for {
		if !mapped.IsZero() && time.Since(mapped) > 700*time.Millisecond {
			return false, nil
		}
		if time.Now().After(deadline) {
			return false, errors.New("no configure from the compositor")
		}
		_ = c.sock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		ev, rerr := c.readEvent()
		var ne net.Error
		if errors.As(rerr, &ne) && ne.Timeout() {
			continue
		}
		if rerr != nil {
			return false, rerr
		}
		r := argReader{b: ev.args}
		switch {
		case ev.obj == displayID && ev.opcode == evDisplayError:
			return false, displayError(ev)
		case ev.obj == layer && ev.opcode == evLayerSurfaceConfigure:
			serial, w, hgt := r.u32(), r.u32(), r.u32()
			send(layer, layerSurfaceAckConfigure, new(msg).u32(serial))
			send(viewport, viewportSetDestination, new(msg).i32(int32(w)).i32(int32(hgt)))
			send(surface, surfaceAttach, new(msg).u32(buffer).i32(0).i32(0))
			send(surface, surfaceCommit, nil)
			if err != nil {
				return false, err
			}
			mapped = time.Now()
		case ev.obj == pointer && ev.opcode == 0: // wl_pointer.enter
			_, s := r.u32(), r.u32()
			if s == surface {
				return true, nil
			}
		}
	}
}
