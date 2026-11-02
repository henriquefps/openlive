// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"strings"
	"testing"
)

func TestParseGStreamerVersion(t *testing.T) {
	cases := []struct {
		in   string
		want [3]int
		ok   bool
	}{
		{"GStreamer 1.28.8", [3]int{1, 28, 8}, true},
		{"1.22.0", [3]int{1, 22, 0}, true},
		{"GStreamer 1.20", [3]int{1, 20, 0}, true},
		{"GStreamer 1.23.1.1 (GIT)", [3]int{1, 23, 1}, true},
		{"", [3]int{}, false},
		{"GStreamer x.y", [3]int{}, false},
	}
	for _, c := range cases {
		got, ok := parseGStreamerVersion(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseGStreamerVersion(%q) = %v, %v; want %v, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestGStreamerVerdict(t *testing.T) {
	if v := gstreamerVerdict("GStreamer 1.22.0"); !strings.HasSuffix(v, "ok") {
		t.Errorf("1.22.0: %q", v)
	}
	if v := gstreamerVerdict("GStreamer 1.28.8"); !strings.HasSuffix(v, "ok") {
		t.Errorf("1.28.8: %q", v)
	}
	if v := gstreamerVerdict("GStreamer 1.20.7"); !strings.Contains(v, "TOO OLD") || !strings.Contains(v, "Flatpak") {
		t.Errorf("1.20.7 should send to the Flatpak: %q", v)
	}
	if v := gstreamerVerdict("?"); !strings.Contains(v, "could not read") {
		t.Errorf("unreadable: %q", v)
	}
}

const kdePortal = `[portal]
DBusName=org.freedesktop.impl.portal.desktop.kde
Interfaces=org.freedesktop.impl.portal.Access;org.freedesktop.impl.portal.ScreenCast;org.freedesktop.impl.portal.GlobalShortcuts;
UseIn=KDE
`

const gtkPortal = `[portal]
DBusName=org.freedesktop.impl.portal.desktop.gtk
Interfaces=org.freedesktop.impl.portal.FileChooser;org.freedesktop.impl.portal.Settings
UseIn=gnome
`

const gnomePortal = `[portal]
DBusName=org.freedesktop.impl.portal.desktop.gnome
Interfaces=org.freedesktop.impl.portal.ScreenCast;org.freedesktop.impl.portal.RemoteDesktop
UseIn=gnome
`

const wlrPortal = `[portal]
DBusName=org.freedesktop.impl.portal.desktop.wlr
Interfaces=org.freedesktop.impl.portal.Screenshot;org.freedesktop.impl.portal.ScreenCast;
UseIn=wlroots;sway;Wayfire;river;phosh;Hyprland;
`

const hyprlandPortal = `[portal]
DBusName=org.freedesktop.impl.portal.desktop.hyprland
Interfaces=org.freedesktop.impl.portal.Screenshot;org.freedesktop.impl.portal.ScreenCast;org.freedesktop.impl.portal.GlobalShortcuts;
UseIn=wlroots;Hyprland;sway;Wayfire;river;
`

func TestChoosePortal(t *testing.T) {
	backends := []portalBackend{
		parsePortalFile("gtk", gtkPortal),
		parsePortalFile("kde", kdePortal),
		parsePortalFile("gnome", gnomePortal),
		parsePortalFile("wlr", wlrPortal),
		parsePortalFile("hyprland", hyprlandPortal),
	}
	if b := backends[1]; b.name != "kde" || len(b.interfaces) != 3 || b.useIn[0] != "KDE" {
		t.Fatalf("parsed kde.portal = %+v", b)
	}
	kdeConf := parsePortalsConf("[preferred]\ndefault=kde\norg.freedesktop.impl.portal.Settings=kde;gtk;\n")
	hyprConf := parsePortalsConf("[preferred]\ndefault=hyprland;gtk\n")
	gnomeConf := parsePortalsConf("[preferred]\ndefault=gnome;gtk;\n")
	cases := []struct {
		name     string
		desktops []string
		conf     map[string][]string
		want     string
	}{
		{"KDE by its conf", []string{"KDE"}, kdeConf, "kde"},
		{"GNOME skips gtk, which has no ScreenCast", []string{"GNOME"}, gnomeConf, "gnome"},
		{"Ubuntu's ubuntu:GNOME without a conf, by UseIn", []string{"ubuntu", "GNOME"}, nil, "gnome"},
		{"Hyprland by its conf", []string{"Hyprland"}, hyprConf, "hyprland"},
		{"sway without a conf: the first UseIn match", []string{"sway"}, nil, "wlr"},
		{"turned off", []string{"KDE"}, map[string][]string{screenCastImpl: {"none"}}, ""},
		{"an unknown desktop", []string{"Nope"}, nil, ""},
	}
	for _, c := range cases {
		if got := choosePortal(screenCastImpl, c.desktops, backends, c.conf); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestParseKWinVersion(t *testing.T) {
	info := "KWin Support Information:\n==========================\n\nVersion\n=======\nKWin version: 6.8.1\nQt Version: 6.10.0\n"
	if got := parseKWinVersion(info); got != "KWin 6.8.1" {
		t.Errorf("got %q", got)
	}
	if got := parseKWinVersion("nothing"); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestDesktopReportLines(t *testing.T) {
	full := desktopReport{
		currentDesktop: "KDE", sessionType: "wayland", portalBackend: "kde", portalConf: "/x/kde-portals.conf",
		installedBackends: []string{"kde"}, screenCastVersion: 5, sourceTypes: 3, cursorModes: 7,
		globalShortcutsVersion: 1, sniWatcher: true, sniHost: true, kwin: true, kwinVersion: "KWin 6.8.1", kwinScripting: true,
	}
	out := strings.Join(full.lines(), "\n")
	for _, want := range []string{"ScreenCast backend kde", "version 5, sources monitor+window", "persist yes", "GlobalShortcuts portal version 1", "StatusNotifier host present", "KWin 6.8.1"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}

	gnome := desktopReport{currentDesktop: "ubuntu:GNOME", sessionType: "wayland", portalBackend: "gnome", screenCastVersion: 3, sourceTypes: 1}
	out = strings.Join(gnome.lines(), "\n")
	for _, want := range []string{"persist no", "no GlobalShortcuts portal", "AppIndicator", "kwin:     not running"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}

	none := desktopReport{busErr: errors.New("no bus")}
	if out := strings.Join(none.lines(), "\n"); !strings.Contains(out, "none found") || !strings.Contains(out, "no session bus") {
		t.Errorf("no bus:\n%s", out)
	}
	if out := strings.Join((desktopReport{}).lines(), "\n"); !strings.Contains(out, "screencast: MISSING") {
		t.Errorf("no portal:\n%s", out)
	}
}

func TestRunRejectsVBVOutOfRange(t *testing.T) {
	for _, v := range []string{"5ms", "3s"} {
		err := runHub([]string{"--vbv", v})
		if err == nil || !strings.Contains(err.Error(), "--vbv") {
			t.Errorf("--vbv %s: err = %v", v, err)
		}
	}
}

func TestProcessCPUTimeGrows(t *testing.T) {
	a, ok := processCPUTime()
	if !ok {
		t.Skip("no CPU time on this system")
	}
	x := 0
	for i := range 20_000_000 {
		x += i % 7
	}
	_ = x
	if b, _ := processCPUTime(); b <= a {
		t.Errorf("CPU time did not grow: %v → %v", a, b)
	}
}
