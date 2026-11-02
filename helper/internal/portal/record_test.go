// SPDX-License-Identifier: AGPL-3.0-only

package portal

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

func TestChoiceMatches(t *testing.T) {
	dp2 := Choice{Kind: KindMonitor, Output: "DP-2", Width: 3440, Height: 1440}
	cases := []struct {
		name   string
		chosen Choice
		got    Choice
		want   bool
	}{
		{"same output", dp2, Choice{Kind: KindMonitor, Output: "DP-2", Width: 3440, Height: 1440}, true},
		// Phase 0 P4: with DP-2 gone the token silently restored another output.
		{"other output", dp2, Choice{Kind: KindMonitor, Output: "HDMI-A-1", Width: 1920, Height: 1080}, false},
		{"same output, new resolution", dp2, Choice{Kind: KindMonitor, Output: "DP-2", Width: 2560, Height: 1080}, true},
		{"kind differs", dp2, Choice{Kind: KindWindow, WindowClass: "code"}, false},
		{"no names, same geometry", Choice{Kind: KindMonitor, X: 1920, Width: 1920, Height: 1080},
			Choice{Kind: KindMonitor, X: 1920, Width: 1920, Height: 1080}, true},
		{"no names, other size", Choice{Kind: KindMonitor, Width: 1920, Height: 1080},
			Choice{Kind: KindMonitor, Width: 2560, Height: 1440}, false},
		{"no names, other position", Choice{Kind: KindMonitor, X: 0, Width: 1920, Height: 1080},
			Choice{Kind: KindMonitor, X: 1920, Width: 1920, Height: 1080}, false},
		{"window, same app, new title", Choice{Kind: KindWindow, WindowClass: "code", WindowCaption: "a.go"},
			Choice{Kind: KindWindow, WindowClass: "Code", WindowCaption: "b.go"}, true},
		{"window, other app", Choice{Kind: KindWindow, WindowClass: "code"},
			Choice{Kind: KindWindow, WindowClass: "brave-browser"}, false},
		{"window, unknown now", Choice{Kind: KindWindow, WindowClass: "code"}, Choice{Kind: KindWindow}, true},
	}
	for _, c := range cases {
		got, why := c.chosen.Matches(c.got)
		if got != c.want {
			t.Errorf("%s: Matches = %v (%s), want %v", c.name, got, why, c.want)
		}
		if !got && why == "" {
			t.Errorf("%s: no reason given", c.name)
		}
	}
}

func TestChoiceSource(t *testing.T) {
	cases := map[string]Choice{
		"DP-2":                      {Kind: KindMonitor, Output: "DP-2"},
		"main.go - code":            {Kind: KindWindow, WindowClass: "code", WindowCaption: "main.go - code"},
		"code":                      {Kind: KindWindow, WindowClass: "code"},
		"Unknown monitor 1920x1080": {Kind: KindMonitor, Width: 1920, Height: 1080},
	}
	for want, c := range cases {
		if got := c.Source().Label; got != want {
			t.Errorf("label %q, want %q", got, want)
		}
	}
}

func TestStoreRotatesTokens(t *testing.T) {
	s := Store{Path: StorePath(t.TempDir())}
	if r, err := s.Load(KindMonitor); err != nil || r.Token != "" {
		t.Fatalf("empty store: %+v, %v", r, err)
	}
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	choice := Choice{Kind: KindMonitor, Output: "DP-2", Width: 3440, Height: 1440}
	if err := s.Save(KindMonitor, Record{Token: "t1", Choice: choice, SavedAt: now}); err != nil {
		t.Fatal(err)
	}
	// The next Start returns a new token: it replaces the old one and keeps the choice.
	if err := s.SaveToken(KindMonitor, "t2", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	r, err := s.Load(KindMonitor)
	if err != nil || r.Token != "t2" || r.Choice != choice || !r.SavedAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("after rotation: %+v, %v", r, err)
	}
	// An empty token (the portal returned none) never erases the saved one.
	if err := s.SaveToken(KindMonitor, "", now); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.Load(KindMonitor); r.Token != "t2" {
		t.Fatalf("empty token erased the saved one: %+v", r)
	}
	// Kinds are kept apart.
	if err := s.SaveToken(KindWindow, "w1", now); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.Load(KindMonitor); r.Token != "t2" {
		t.Fatalf("window token overwrote the monitor one: %+v", r)
	}
	if err := s.Forget(KindMonitor); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.Load(KindMonitor); r.Token != "" || r.Choice != choice {
		t.Fatalf("after Forget: %+v", r)
	}
	if r, _ := s.Load(KindWindow); r.Token != "w1" {
		t.Fatalf("Forget(monitor) touched the window: %+v", r)
	}
	info, err := os.Stat(s.Path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v, %v; want 0600", info.Mode().Perm(), err)
	}
}

func TestStoreCorruptFile(t *testing.T) {
	s := Store{Path: filepath.Join(t.TempDir(), "screencast.json")}
	if err := os.WriteFile(s.Path, []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(KindMonitor); err == nil {
		t.Fatal("corrupt file loaded")
	}
	// A new token is still saved.
	if err := s.SaveToken(KindMonitor, "t1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if r, err := s.Load(KindMonitor); err != nil || r.Token != "t1" {
		t.Fatalf("%+v, %v", r, err)
	}
}

func TestParseKind(t *testing.T) {
	for in, want := range map[string]Kind{"monitor": KindMonitor, "screen": KindMonitor, "Window": KindWindow} {
		if got, err := ParseKind(in); err != nil || got != want {
			t.Errorf("ParseKind(%q) = %v, %v", in, got, err)
		}
	}
	if _, err := ParseKind("region"); err == nil {
		t.Error("region accepted")
	}
}

func TestStreamFromProps(t *testing.T) {
	s := streamFromProps(97, map[string]dbus.Variant{
		"size":            dbus.MakeVariant([]any{int32(3440), int32(1440)}),
		"position":        dbus.MakeVariant([]any{int32(1920), int32(0)}),
		"pipewire-serial": dbus.MakeVariant(uint64(5123)),
		"source_type":     dbus.MakeVariant(uint32(1)),
	})
	want := Stream{NodeID: 97, Serial: 5123, Kind: KindMonitor, Width: 3440, Height: 1440, X: 1920, HasPosition: true}
	if s != want {
		t.Fatalf("%+v, want %+v", s, want)
	}
	// A restored window: size 0x0 and no position (Phase 0 P7).
	s = streamFromProps(98, map[string]dbus.Variant{"size": dbus.MakeVariant([]any{int32(0), int32(0)}), "source_type": dbus.MakeVariant(uint32(2))})
	if s.Width != 0 || s.HasPosition || s.Kind != KindWindow {
		t.Fatalf("restored window: %+v", s)
	}
}
