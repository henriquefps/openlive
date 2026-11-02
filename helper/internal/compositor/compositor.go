// SPDX-License-Identifier: AGPL-3.0-only

// Package compositor asks the desktop compositor what the portal does not say: the name of
// a captured output, which window a window stream shows, and whether that window is
// minimized. On KDE, KWin keeps sending a minimized window's frames and
// gives no paused signal (Phase 0 P7), so the helper watches the window itself.
//
// Only KWin (Plasma 6) is implemented. Elsewhere Watch fails with ErrUnsupported and the
// helper streams without the paused state and without output names.
package compositor

import (
	"errors"
	"strings"
)

// Window is a toplevel window as the compositor sees it. Sizes are in logical pixels.
type Window struct {
	ID        string `json:"id"`
	Caption   string `json:"caption"`
	Class     string `json:"class"`
	PID       int    `json:"pid"`
	Minimized bool   `json:"minimized"`
	// Frame includes the decoration; Client is the content; Buffer is what the window
	// renders (client plus client-side shadows).
	FrameW  int `json:"fw"`
	FrameH  int `json:"fh"`
	ClientW int `json:"cw"`
	ClientH int `json:"ch"`
	BufferW int `json:"bw"`
	BufferH int `json:"bh"`
	// The same rectangles' top left corners, in global logical pixels (the pointer pings).
	FrameX  int `json:"fx"`
	FrameY  int `json:"fy"`
	ClientX int `json:"cx"`
	ClientY int `json:"cy"`
	BufferX int `json:"bx"`
	BufferY int `json:"by"`
	// Scale is the device pixel ratio of the window's output.
	Scale float64 `json:"scale"`
	// Output is the name of the window's output ("" when KWin gives none).
	Output string `json:"output"`
}

// Output is a monitor.
type Output struct {
	Name   string  `json:"name"`
	X      int     `json:"x"`
	Y      int     `json:"y"`
	Width  int     `json:"w"`
	Height int     `json:"h"`
	Scale  float64 `json:"scale"`
}

// Snapshot is the compositor's state at one moment.
type Snapshot struct {
	Windows []Window `json:"windows"`
	Outputs []Output `json:"outputs"`
}

// Window returns the window with that id.
func (s Snapshot) Window(id string) (Window, bool) {
	for _, w := range s.Windows {
		if w.ID == id {
			return w, true
		}
	}
	return Window{}, false
}

// ErrUnsupported is returned where no compositor query is implemented.
var ErrUnsupported = errors.New("compositor queries are not supported on this desktop")

// MatchOutput finds the output a monitor stream shows: by position first (the portal
// reports it on KDE), then by size in logical or physical pixels when it is unique.
func MatchOutput(outputs []Output, x, y int, hasPosition bool, w, h int) (Output, bool) {
	if hasPosition {
		for _, o := range outputs {
			if o.X == x && o.Y == y && (w == 0 || sizeMatches(o.Width, o.Height, o.Scale, w, h)) {
				return o, true
			}
		}
	}
	var found []Output
	for _, o := range outputs {
		if w > 0 && sizeMatches(o.Width, o.Height, o.Scale, w, h) {
			found = append(found, o)
		}
	}
	if len(found) == 1 {
		return found[0], true
	}
	return Output{}, false
}

// sizeMatches compares a logical size with a stream size that may be logical or physical.
func sizeMatches(lw, lh int, scale float64, w, h int) bool {
	if near(lw, w) && near(lh, h) {
		return true
	}
	if scale > 0 && scale != 1 {
		return near(int(float64(lw)*scale+0.5), w) && near(int(float64(lh)*scale+0.5), h)
	}
	return false
}

func near(a, b int) bool { return a-b <= 2 && b-a <= 2 }

// MatchWindow finds the window a window stream shows from the stream's frame size, which
// is all the portal gives (it reports no window id, and 0x0 for a restored window). A
// window matches when its client, buffer or frame size equals the frame size, in logical
// or physical pixels. hint (a caption or class substring) breaks ties; without one, a tie
// is no match: a wrong window would pause the stream at the wrong time.
func MatchWindow(windows []Window, w, h int, hint string) (Window, bool) {
	found := ofSize(windows, w, h)
	if len(found) == 1 {
		return found[0], true
	}
	if hint = strings.ToLower(strings.TrimSpace(hint)); hint != "" {
		var hinted []Window
		for _, win := range found {
			if strings.Contains(strings.ToLower(win.Caption), hint) || strings.Contains(strings.ToLower(win.Class), hint) {
				hinted = append(hinted, win)
			}
		}
		if len(hinted) == 1 {
			return hinted[0], true
		}
	}
	return Window{}, false
}

// ofSize lists the windows whose client, buffer or frame size is w x h.
func ofSize(windows []Window, w, h int) []Window {
	if w <= 0 || h <= 0 {
		return nil
	}
	var found []Window
	for _, win := range windows {
		if sizeMatches(win.ClientW, win.ClientH, win.Scale, w, h) ||
			sizeMatches(win.BufferW, win.BufferH, win.Scale, w, h) ||
			sizeMatches(win.FrameW, win.FrameH, win.Scale, w, h) {
			found = append(found, win)
		}
	}
	return found
}

// MatchApp finds the application of a window stream when MatchWindow cannot tell the
// window: every window of the stream's size belongs to one process (two browser windows
// of the same size, the usual case). The result has the class and PID only, no ID or
// caption, so the app's audio can still be captured while the minimized pause stays off.
func MatchApp(windows []Window, w, h int) (Window, bool) {
	found := ofSize(windows, w, h)
	if len(found) == 0 || found[0].PID <= 0 {
		return Window{}, false
	}
	for _, win := range found[1:] {
		if win.PID != found[0].PID || win.Class != found[0].Class {
			return Window{}, false
		}
	}
	return Window{Class: found[0].Class, PID: found[0].PID}, true
}
