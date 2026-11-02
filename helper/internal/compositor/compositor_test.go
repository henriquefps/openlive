// SPDX-License-Identifier: AGPL-3.0-only

package compositor

import (
	"encoding/json"
	"testing"
)

func TestMatchOutput(t *testing.T) {
	outputs := []Output{
		{Name: "DP-2", X: 0, Y: 0, Width: 3440, Height: 1440, Scale: 1},
		{Name: "HDMI-A-1", X: 3440, Y: 0, Width: 1920, Height: 1080, Scale: 1},
		{Name: "eDP-1", X: 5360, Y: 0, Width: 1280, Height: 800, Scale: 2},
	}
	cases := []struct {
		name         string
		x, y         int
		pos          bool
		w, h         int
		want         string
		wantNotFound bool
	}{
		{"by position", 3440, 0, true, 1920, 1080, "HDMI-A-1", false},
		{"by size only", 0, 0, false, 3440, 1440, "DP-2", false},
		{"physical size on a 2x output", 0, 0, false, 2560, 1600, "eDP-1", false},
		{"position without size", 5360, 0, true, 0, 0, "eDP-1", false},
		{"nothing fits", 0, 0, false, 800, 600, "", true},
	}
	for _, c := range cases {
		got, ok := MatchOutput(outputs, c.x, c.y, c.pos, c.w, c.h)
		if ok == c.wantNotFound || got.Name != c.want {
			t.Errorf("%s: %+v %v, want %q", c.name, got, ok, c.want)
		}
	}
	twins := []Output{{Name: "DP-1", Width: 1920, Height: 1080}, {Name: "DP-2", X: 1920, Width: 1920, Height: 1080}}
	if o, ok := MatchOutput(twins, 0, 0, false, 1920, 1080); ok {
		t.Errorf("two outputs of one size matched %s without a position", o.Name)
	}
}

func TestMatchWindow(t *testing.T) {
	windows := []Window{
		{ID: "a", Caption: "main.go - code", Class: "code", ClientW: 1628, ClientH: 1080, BufferW: 1660, BufferH: 1122, Scale: 1},
		// Two browser windows of the same size (the KWin snapshot on this machine had that).
		{ID: "b", Caption: "Openlive - Brave", Class: "brave-browser", ClientW: 1751, ClientH: 1030, Scale: 1},
		{ID: "c", Caption: "Docs - Brave", Class: "brave-browser", ClientW: 1751, ClientH: 1030, Scale: 1},
		{ID: "d", Caption: "Konsole", Class: "org.kde.konsole", ClientW: 911, ClientH: 468, FrameW: 911, FrameH: 496, Scale: 1.5},
	}
	cases := []struct {
		name string
		w, h int
		hint string
		want string
	}{
		{"client size", 1628, 1080, "", "a"},
		{"buffer size (client-side shadows)", 1660, 1122, "", "a"},
		{"physical size at 1.5x", 1367, 702, "", "d"},
		{"tie without a hint", 1751, 1030, "", ""},
		{"tie broken by the hint", 1751, 1030, "openlive", "b"},
		{"hint that fits both", 1751, 1030, "brave", ""},
		{"unknown size", 0, 0, "", ""},
	}
	for _, c := range cases {
		got, ok := MatchWindow(windows, c.w, c.h, c.hint)
		if (c.want == "") == ok || got.ID != c.want {
			t.Errorf("%s: %q %v, want %q", c.name, got.ID, ok, c.want)
		}
	}
}

func TestMatchApp(t *testing.T) {
	windows := []Window{
		// Two windows of one browser process, of the same size (this machine's KWin snapshot
		// during a manual run: MatchWindow could not tell them apart, so a shared Brave
		// window had no app audio).
		{ID: "b", Caption: "Openlive - Brave", Class: "brave-browser", PID: 4100, ClientW: 1751, ClientH: 1030, Scale: 1},
		{ID: "c", Caption: "Docs - Brave", Class: "brave-browser", PID: 4100, ClientW: 1751, ClientH: 1030, Scale: 1},
		// Same size, two different apps.
		{ID: "e", Class: "code", PID: 5000, ClientW: 1280, ClientH: 800, Scale: 1},
		{ID: "f", Class: "winboat", PID: 6000, ClientW: 1280, ClientH: 800, Scale: 1},
		{ID: "g", Class: "steam", ClientW: 1720, ClientH: 1390, Scale: 1},
	}
	if got, ok := MatchApp(windows, 1751, 1030); !ok || got != (Window{Class: "brave-browser", PID: 4100}) {
		t.Errorf("one app's windows: %+v %v", got, ok)
	}
	if got, ok := MatchApp(windows, 1280, 800); ok {
		t.Errorf("two apps of one size: %+v", got)
	}
	if got, ok := MatchApp(windows, 1720, 1390); ok {
		t.Errorf("a window without a PID: %+v", got)
	}
	if _, ok := MatchApp(windows, 640, 480); ok {
		t.Error("no window of that size")
	}
}

func TestSnapshotWindow(t *testing.T) {
	s := Snapshot{Windows: []Window{{ID: "x", Minimized: true}}}
	if w, ok := s.Window("x"); !ok || !w.Minimized {
		t.Fatalf("%+v %v", w, ok)
	}
	if _, ok := s.Window("y"); ok {
		t.Fatal("found a missing window")
	}
}

func TestSnapshotWindowPositions(t *testing.T) {
	var s Snapshot
	raw := `{"windows":[{"id":"w","fw":804,"fh":632,"cw":800,"ch":600,"bw":804,"bh":632,"fx":100,"fy":200,"cx":102,"cy":230,"bx":100,"by":200,"scale":1.25,"output":"DP-1"}],"outputs":[]}`
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatal(err)
	}
	w := s.Windows[0]
	if w.FrameX != 100 || w.FrameY != 200 || w.ClientX != 102 || w.ClientY != 230 || w.BufferX != 100 || w.BufferY != 200 {
		t.Errorf("%+v", w)
	}
}
