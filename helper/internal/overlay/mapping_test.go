// SPDX-License-Identifier: AGPL-3.0-only

package overlay

import (
	"errors"
	"math"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/compositor"
)

// Two monitors side by side: a 1920x1080 one at scale 1 and a 4K one at 1.5 (2560x1440
// logical) right of it.
var twoOutputs = []compositor.Output{
	{Name: "DP-1", X: 0, Y: 0, Width: 1920, Height: 1080, Scale: 1},
	{Name: "DP-2", X: 1920, Y: 0, Width: 2560, Height: 1440, Scale: 1.5},
}

func near(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.01 {
		t.Errorf("%s = %.3f, want %.3f", what, got, want)
	}
}

func TestMapScreen(t *testing.T) {
	snap := compositor.Snapshot{Outputs: twoOutputs}
	// The 4K monitor is captured at its pixels (3840x2160) and sent at 1080p.
	src := Source{FrameW: 1920, FrameH: 1080, SrcW: 3840, SrcH: 2160, Output: "DP-2"}
	for _, c := range []struct {
		x, y, wantX, wantY float64
	}{
		{0, 0, 0, 0},
		{0.5, 0.5, 1280, 720},
		{1, 1, 2560, 1440},
		{0.25, 0.75, 640, 1080},
	} {
		p, err := Map(src, snap, c.x, c.y)
		if err != nil {
			t.Fatalf("%v,%v: %v", c.x, c.y, err)
		}
		if p.Output.Name != "DP-2" || p.Output.Scale != 1.5 {
			t.Errorf("output %+v", p.Output)
		}
		near(t, "x", p.X, c.wantX)
		near(t, "y", p.Y, c.wantY)
	}
}

func TestMapScreenLetterbox(t *testing.T) {
	snap := compositor.Snapshot{Outputs: twoOutputs}
	// The content fills 1800 of the frame's 1920 columns, 60 px of black on each side.
	src := Source{FrameW: 1920, FrameH: 1080, Content: Rect{X: 60, Y: 0, W: 1800, H: 1080}, Output: "DP-1"}
	p, err := Map(src, snap, 60.0/1920, 0.5)
	if err != nil {
		t.Fatal(err)
	}
	near(t, "left edge of the content", p.X, 0)
	p, err = Map(src, snap, 0.5, 0.5)
	if err != nil {
		t.Fatal(err)
	}
	near(t, "center", p.X, 960)
	if _, err := Map(src, snap, 10.0/1920, 0.5); !errors.Is(err, ErrOutside) {
		t.Errorf("a ping on the black bar: %v, want ErrOutside", err)
	}
}

func TestMapOutOfBounds(t *testing.T) {
	snap := compositor.Snapshot{Outputs: twoOutputs}
	src := Source{FrameW: 1920, FrameH: 1080, Output: "DP-1"}
	for _, xy := range [][2]float64{{-0.01, 0.5}, {0.5, 1.01}, {math.NaN(), 0}, {2, 2}} {
		if _, err := Map(src, snap, xy[0], xy[1]); !errors.Is(err, ErrOutside) {
			t.Errorf("%v: %v, want ErrOutside", xy, err)
		}
	}
	if _, err := Map(Source{FrameW: 1920, FrameH: 1080, Output: "HDMI-9"}, snap, 0.5, 0.5); !errors.Is(err, ErrUnknownSource) {
		t.Errorf("unknown output: %v", err)
	}
	if _, err := Map(Source{Output: "DP-1"}, snap, 0.5, 0.5); !errors.Is(err, ErrUnknownSource) {
		t.Errorf("no frame size: %v", err)
	}
}

func window(id string) compositor.Window {
	// Server-side decorations: the frame is 2 px wider and 30 px taller than the client.
	return compositor.Window{ID: id, Caption: "Editor", Scale: 1, Output: "DP-1",
		FrameX: 100, FrameY: 200, FrameW: 804, FrameH: 632,
		ClientX: 102, ClientY: 230, ClientW: 800, ClientH: 600,
		BufferX: 100, BufferY: 200, BufferW: 804, BufferH: 632}
}

func TestMapWindow(t *testing.T) {
	snap := compositor.Snapshot{Outputs: twoOutputs, Windows: []compositor.Window{window("a")}}
	src := Source{Window: true, FrameW: 800, FrameH: 600, SrcW: 800, SrcH: 600, WindowID: "a"}
	p, err := Map(src, snap, 0.5, 0.5)
	if err != nil {
		t.Fatal(err)
	}
	if p.Output.Name != "DP-1" {
		t.Errorf("output %q", p.Output.Name)
	}
	// The client geometry matches the capture's size.
	near(t, "x", p.X, 102+400)
	near(t, "y", p.Y, 230+300)

	// A capture of the frame (with the decoration) maps onto the frame geometry.
	src.SrcW, src.SrcH = 804, 632
	p, err = Map(src, snap, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	near(t, "frame x", p.X, 100)
	near(t, "frame y", p.Y, 200)
}

func TestMapWindowFollowsMoveAcrossOutputs(t *testing.T) {
	w := window("a")
	// Moved so it straddles both monitors: its right half is on DP-2.
	w.ClientX, w.ClientY = 1600, 100
	snap := compositor.Snapshot{Outputs: twoOutputs, Windows: []compositor.Window{w}}
	src := Source{Window: true, FrameW: 800, FrameH: 600, SrcW: 800, SrcH: 600, WindowID: "a"}
	p, err := Map(src, snap, 0.25, 0.5) // global x 1800
	if err != nil {
		t.Fatal(err)
	}
	if p.Output.Name != "DP-1" {
		t.Errorf("left half on %q", p.Output.Name)
	}
	near(t, "x on DP-1", p.X, 1800)
	p, err = Map(src, snap, 0.75, 0.5) // global x 2200
	if err != nil {
		t.Fatal(err)
	}
	if p.Output.Name != "DP-2" {
		t.Errorf("right half on %q", p.Output.Name)
	}
	near(t, "x on DP-2", p.X, 2200-1920)
	near(t, "y on DP-2", p.Y, 400)
}

func TestMapWindowScaled(t *testing.T) {
	// A window on the 1.5 monitor, captured at its physical pixels (1200x900).
	w := compositor.Window{ID: "b", Scale: 1.5, Output: "DP-2",
		ClientX: 2000, ClientY: 100, ClientW: 800, ClientH: 600,
		FrameX: 2000, FrameY: 70, FrameW: 800, FrameH: 630}
	snap := compositor.Snapshot{Outputs: twoOutputs, Windows: []compositor.Window{w}}
	src := Source{Window: true, FrameW: 1200, FrameH: 900, SrcW: 1200, SrcH: 900, WindowID: "b"}
	p, err := Map(src, snap, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if p.Output.Name != "DP-2" {
		t.Fatalf("output %q", p.Output.Name)
	}
	// Logical pixels of DP-2: the client's bottom right corner.
	near(t, "x", p.X, 2800-1920)
	near(t, "y", p.Y, 700)
}

func TestMapWindowDropped(t *testing.T) {
	off := window("off")
	off.ClientX, off.ClientY = -700, 100 // mostly left of every monitor
	min := window("min")
	min.Minimized = true
	snap := compositor.Snapshot{Outputs: twoOutputs, Windows: []compositor.Window{off, min}}
	src := Source{Window: true, FrameW: 800, FrameH: 600, SrcW: 800, SrcH: 600}

	src.WindowID = "off"
	if _, err := Map(src, snap, 0.1, 0.5); !errors.Is(err, ErrOffscreen) {
		t.Errorf("off screen: %v", err)
	}
	if _, err := Map(src, snap, 0.99, 0.5); err != nil {
		t.Errorf("the visible part of the window: %v", err)
	}
	src.WindowID = "min"
	if _, err := Map(src, snap, 0.5, 0.5); !errors.Is(err, ErrMinimized) {
		t.Errorf("minimized: %v", err)
	}
	src.WindowID = "gone"
	if _, err := Map(src, snap, 0.5, 0.5); !errors.Is(err, ErrUnknownSource) {
		t.Errorf("closed window: %v", err)
	}
	src.WindowID = ""
	if _, err := Map(src, snap, 0.5, 0.5); !errors.Is(err, ErrUnknownSource) {
		t.Errorf("no window id: %v", err)
	}
}

func TestWindowRectFallsBackToClient(t *testing.T) {
	w := window("a")
	if r := WindowRect(w, 0, 0); r != (Rect{102, 230, 800, 600}) {
		t.Errorf("unknown capture size: %+v, want the client geometry", r)
	}
	w.ClientW, w.ClientH = 0, 0
	if r := WindowRect(w, 0, 0); r != (Rect{100, 200, 804, 632}) {
		t.Errorf("no client geometry: %+v, want the frame", r)
	}
}
