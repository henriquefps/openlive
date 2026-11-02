// SPDX-License-Identifier: AGPL-3.0-only

// Package overlay draws viewers' pointer pings on the streamer's screen (PROTOCOL.md §7.9):
// a pulsing marker with the viewer's name, for about two seconds, at the point of the
// shared screen or window that was clicked in the video. Nothing is injected; the marker
// takes no input, so clicks go to what is under it.
//
// On Linux it is a Wayland client of its own (wlr layer shell, overlay layer) drawing in
// shared memory, without Qt or GTK. Elsewhere Probe says no and the helper
// announces pingOverlay=false.
package overlay

import (
	"errors"
	"math"

	"github.com/henriquefps/openlive/helper/internal/compositor"
)

// Rect is a rectangle in integer pixels.
type Rect struct{ X, Y, W, H int }

// Source says what a stream's video frame shows, for mapping a ping back to the desktop.
type Source struct {
	// Window is true for a window stream, false for a monitor.
	Window bool
	// FrameW and FrameH are the video frame's size (the top layer); Content is where the
	// captured source sits in it (a resized window is letterboxed).
	FrameW, FrameH int
	Content        Rect
	// SrcW and SrcH are the capture's size, which tells a window's client, buffer or frame
	// geometry apart (in logical or physical pixels).
	SrcW, SrcH int
	// Output is the shared monitor's name (monitor streams).
	Output string
	// WindowID is the shared window's KWin id (window streams).
	WindowID string
}

// Point is a ping's place on one output, in that output's logical pixels.
type Point struct {
	Output compositor.Output
	X, Y   float64
}

// Reasons a ping is not drawn.
var (
	ErrOutside       = errors.New("the ping is outside the shared source")
	ErrUnknownSource = errors.New("the shared output or window is not known")
	ErrOffscreen     = errors.New("the ping falls outside every output")
	ErrMinimized     = errors.New("the shared window is minimized")
)

// Map turns a ping at x, y (0 to 1 over the video frame) into a point on an output.
//
// A monitor stream maps the frame's content onto the output's logical geometry. A window
// stream maps it onto the window's current geometry (KWin's latest snapshot, so a moved
// window is followed), and the point lands on whichever output contains it: a window
// across two monitors gets the marker on the right one, and a point of the window that is
// off every screen is dropped.
func Map(src Source, snap compositor.Snapshot, x, y float64) (Point, error) {
	if math.IsNaN(x) || math.IsNaN(y) || x < 0 || x > 1 || y < 0 || y > 1 {
		return Point{}, ErrOutside
	}
	c := src.Content
	if c.W <= 0 || c.H <= 0 {
		c = Rect{0, 0, src.FrameW, src.FrameH}
	}
	if c.W <= 0 || c.H <= 0 {
		return Point{}, ErrUnknownSource
	}
	// From the frame to the content (0 to 1 over the captured source).
	u := (x*float64(src.FrameW) - float64(c.X)) / float64(c.W)
	v := (y*float64(src.FrameH) - float64(c.Y)) / float64(c.H)
	const eps = 1e-6
	if u < -eps || u > 1+eps || v < -eps || v > 1+eps {
		return Point{}, ErrOutside // on the letterbox's black bars
	}
	u, v = clamp01(u), clamp01(v)

	if !src.Window {
		for _, o := range snap.Outputs {
			if o.Name == src.Output && o.Name != "" {
				return Point{Output: o, X: u * float64(o.Width), Y: v * float64(o.Height)}, nil
			}
		}
		return Point{}, ErrUnknownSource
	}
	win, ok := snap.Window(src.WindowID)
	if !ok || src.WindowID == "" {
		return Point{}, ErrUnknownSource
	}
	if win.Minimized {
		return Point{}, ErrMinimized
	}
	r := WindowRect(win, src.SrcW, src.SrcH)
	if r.W <= 0 || r.H <= 0 {
		return Point{}, ErrUnknownSource
	}
	gx, gy := float64(r.X)+u*float64(r.W), float64(r.Y)+v*float64(r.H)
	for _, o := range snap.Outputs {
		if gx >= float64(o.X) && gx < float64(o.X+o.Width) && gy >= float64(o.Y) && gy < float64(o.Y+o.Height) {
			return Point{Output: o, X: gx - float64(o.X), Y: gy - float64(o.Y)}, nil
		}
	}
	return Point{}, ErrOffscreen
}

// WindowRect is the part of the window a window stream shows, in global logical pixels:
// the client, buffer or frame geometry whose size is the capture's (in logical or
// physical pixels), the client geometry when none or several match.
func WindowRect(w compositor.Window, srcW, srcH int) Rect {
	client := Rect{w.ClientX, w.ClientY, w.ClientW, w.ClientH}
	frame := Rect{w.FrameX, w.FrameY, w.FrameW, w.FrameH}
	buffer := Rect{w.BufferX, w.BufferY, w.BufferW, w.BufferH}
	for _, r := range []Rect{client, frame, buffer} {
		if r.W > 0 && r.H > 0 && sizeMatches(r.W, r.H, w.Scale, srcW, srcH) {
			return r
		}
	}
	if client.W > 0 && client.H > 0 {
		return client
	}
	return frame
}

func sizeMatches(lw, lh int, scale float64, w, h int) bool {
	near := func(a, b int) bool { return a-b <= 2 && b-a <= 2 }
	if near(lw, w) && near(lh, h) {
		return true
	}
	return scale > 0 && scale != 1 &&
		near(int(float64(lw)*scale+0.5), w) && near(int(float64(lh)*scale+0.5), h)
}

func clamp01(v float64) float64 { return math.Min(1, math.Max(0, v)) }
