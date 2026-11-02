// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/godbus/dbus/v5"
)

// The desktop part of doctor: what the helper relies on outside GStreamer, so a report from
// an untested desktop says at once what will and will not work (helper/README.md
// "Desktop compatibility").

// minGStreamer is the oldest GStreamer the helper supports. 1.22 is the first with the
// va plugin's encoders (vah264enc, vah264lpenc) and the CUDA-memory nvcodec encoder
// (nvh264enc with cudaupload) whose bitrate changes while playing. Older systems use the
// Flatpak, whose runtime brings its own GStreamer.
var minGStreamer = [3]int{1, 22, 0}

// parseGStreamerVersion reads "GStreamer 1.24.2" (or "1.24.2") into its numbers.
func parseGStreamerVersion(s string) ([3]int, bool) {
	var v [3]int
	fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(s), "GStreamer"))
	if len(fields) == 0 {
		return v, false
	}
	parts := strings.SplitN(fields[0], ".", 4)
	if len(parts) < 2 {
		return v, false
	}
	for i := 0; i < 3 && i < len(parts); i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return v, false
		}
		v[i] = n
	}
	return v, true
}

// versionAtLeast compares major.minor.micro.
func versionAtLeast(v, min [3]int) bool {
	for i := range v {
		if v[i] != min[i] {
			return v[i] > min[i]
		}
	}
	return true
}

// gstreamerVerdict is the doctor line for the GStreamer version.
func gstreamerVerdict(version string) string {
	v, ok := parseGStreamerVersion(version)
	min := fmt.Sprintf("%d.%d", minGStreamer[0], minGStreamer[1])
	switch {
	case !ok:
		return "minimum:  " + min + " (could not read this version)"
	case versionAtLeast(v, minGStreamer):
		return "minimum:  " + min + ", ok"
	default:
		return "minimum:  " + min + ", TOO OLD: hardware encoders will be missing; use the Flatpak (helper/README.md \"Install on Linux\")"
	}
}

// portalBackend is one xdg-desktop-portal implementation (a .portal file).
type portalBackend struct {
	name       string // the file name without .portal: kde, gnome, gtk, wlr, hyprland…
	interfaces []string
	useIn      []string
}

// parsePortalFile reads a /usr/share/xdg-desktop-portal/portals/*.portal file.
func parsePortalFile(name, content string) portalBackend {
	p := portalBackend{name: name}
	for _, line := range strings.Split(content, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "Interfaces":
			p.interfaces = splitList(value)
		case "UseIn":
			p.useIn = splitList(value)
		}
	}
	return p
}

// parsePortalsConf reads a <desktop>-portals.conf or portals.conf: the [preferred]
// section's default and per-interface choices.
func parsePortalsConf(content string) map[string][]string {
	out := map[string][]string{}
	section := ""
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			section = strings.Trim(line, "[]")
			continue
		}
		if key, value, ok := strings.Cut(line, "="); ok && section == "preferred" {
			out[strings.TrimSpace(key)] = splitList(value)
		}
	}
	return out
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ";") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

const screenCastImpl = "org.freedesktop.impl.portal.ScreenCast"

// choosePortal is the backend xdg-desktop-portal (1.18+) would use for an interface:
// the first configured one that is installed and implements it, else (no configuration)
// the first installed one whose UseIn names the desktop. "" when none fits.
func choosePortal(iface string, desktops []string, backends []portalBackend, conf map[string][]string) string {
	implements := func(name string) bool {
		for _, b := range backends {
			if b.name == name && slices.Contains(b.interfaces, iface) {
				return true
			}
		}
		return false
	}
	if conf != nil {
		choices := conf[iface]
		if len(choices) == 0 {
			choices = conf["default"]
		}
		for _, c := range choices {
			if c == "none" {
				return ""
			}
			if c == "*" {
				break
			}
			if implements(c) {
				return c
			}
		}
	}
	for _, d := range desktops {
		for _, b := range backends {
			if slices.ContainsFunc(b.useIn, func(u string) bool { return strings.EqualFold(u, d) }) && slices.Contains(b.interfaces, iface) {
				return b.name
			}
		}
	}
	return ""
}

// portalConfig loads the installed backends and the configuration that applies to the
// desktops, in xdg-desktop-portal's lookup order (user, then system; desktop-specific first).
func portalConfig(desktops []string) ([]portalBackend, map[string][]string, string) {
	var backends []portalBackend
	files, _ := filepath.Glob("/usr/share/xdg-desktop-portal/portals/*.portal")
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		backends = append(backends, parsePortalFile(strings.TrimSuffix(filepath.Base(f), ".portal"), string(data)))
	}
	var dirs []string
	if home, err := os.UserConfigDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, "xdg-desktop-portal"))
	}
	dirs = append(dirs, "/etc/xdg-desktop-portal", "/usr/share/xdg-desktop-portal")
	for _, dir := range dirs {
		names := make([]string, 0, len(desktops)+1)
		for _, d := range desktops {
			names = append(names, strings.ToLower(d)+"-portals.conf")
		}
		names = append(names, "portals.conf")
		for _, n := range names {
			path := filepath.Join(dir, n)
			if data, err := os.ReadFile(path); err == nil {
				return backends, parsePortalsConf(string(data)), path
			}
		}
	}
	return backends, nil, ""
}

// desktopReport collects the desktop facts doctor prints.
type desktopReport struct {
	currentDesktop, sessionType string
	portalBackend, portalConf   string
	installedBackends           []string
	screenCastVersion           uint32 // 0: no ScreenCast portal
	sourceTypes, cursorModes    uint32
	globalShortcutsVersion      uint32 // 0: absent
	sniWatcher, sniHost         bool
	kwin                        bool
	kwinVersion                 string
	kwinScripting               bool
	busErr                      error
}

func (r desktopReport) lines() []string {
	out := []string{
		fmt.Sprintf("desktop:  %s (XDG_CURRENT_DESKTOP), session %s", orUnknown(r.currentDesktop), orUnknown(r.sessionType)),
	}
	backend := r.portalBackend
	if backend == "" {
		backend = "none found"
	}
	conf := r.portalConf
	if conf == "" {
		conf = "no portals.conf, by UseIn"
	}
	out = append(out, fmt.Sprintf("portal:   ScreenCast backend %s (%s); installed: %s", backend, conf, strings.Join(r.installedBackends, ", ")))
	if r.busErr != nil {
		return append(out, fmt.Sprintf("d-bus:    no session bus (%v): portal, tray and shortcut checks skipped", r.busErr))
	}
	if r.screenCastVersion == 0 {
		out = append(out, "screencast: MISSING: the helper cannot capture the screen (install the xdg-desktop-portal backend of this desktop)")
	} else {
		persist := "no (the system dialog asks every time)"
		if r.screenCastVersion >= 4 {
			persist = "yes (restore without the dialog)"
		}
		out = append(out, fmt.Sprintf("screencast: version %d, sources %s, cursor modes %s, persist %s",
			r.screenCastVersion, sourceTypeNames(r.sourceTypes), cursorModeNames(r.cursorModes), persist))
	}
	if r.globalShortcutsVersion == 0 {
		out = append(out, "shortcuts: no GlobalShortcuts portal: global shortcuts are off (the tray and the web still work)")
	} else {
		out = append(out, fmt.Sprintf("shortcuts: GlobalShortcuts portal version %d", r.globalShortcutsVersion))
	}
	switch {
	case r.sniHost:
		out = append(out, "tray:     StatusNotifier host present")
	case r.sniWatcher:
		out = append(out, "tray:     StatusNotifier watcher without a host: no tray icon will show (GNOME needs the AppIndicator extension)")
	default:
		out = append(out, "tray:     no StatusNotifier watcher: no tray icon (GNOME needs the AppIndicator extension)")
	}
	if r.kwin {
		version := r.kwinVersion
		if version == "" {
			version = "version unknown"
		}
		feat := "window minimized state and output names: yes"
		if !r.kwinScripting {
			feat = "scripting interface missing: no window minimized state or output names"
		}
		out = append(out, fmt.Sprintf("kwin:     %s; %s", version, feat))
	} else {
		out = append(out, "kwin:     not running: no minimized-window pause and no output names (KWin only)")
	}
	return out
}

func orUnknown(s string) string {
	if s == "" {
		return "?"
	}
	return s
}

func sourceTypeNames(bits uint32) string {
	return bitNames(bits, []string{"monitor", "window", "virtual"})
}

func cursorModeNames(bits uint32) string {
	return bitNames(bits, []string{"hidden", "embedded", "metadata"})
}

func bitNames(bits uint32, names []string) string {
	var out []string
	for i, n := range names {
		if bits&(1<<i) != 0 {
			out = append(out, n)
		}
	}
	if len(out) == 0 {
		return "none"
	}
	return strings.Join(out, "+")
}

// parseKWinVersion finds "KWin version: 6.5.1" in KWin's supportInformation text.
func parseKWinVersion(info string) string {
	sc := bufio.NewScanner(strings.NewReader(info))
	for sc.Scan() {
		if v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "KWin version:"); ok {
			return "KWin " + strings.TrimSpace(v)
		}
	}
	return ""
}

// inspectDesktop reads the environment, the portal configuration and the session bus.
func inspectDesktop() desktopReport {
	r := desktopReport{currentDesktop: os.Getenv("XDG_CURRENT_DESKTOP"), sessionType: os.Getenv("XDG_SESSION_TYPE")}
	desktops := splitList(strings.ReplaceAll(r.currentDesktop, ":", ";"))
	backends, conf, confPath := portalConfig(desktops)
	for _, b := range backends {
		r.installedBackends = append(r.installedBackends, b.name)
	}
	r.portalBackend = choosePortal(screenCastImpl, desktops, backends, conf)
	r.portalConf = confPath

	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		r.busErr = err
		return r
	}
	defer func() { _ = conn.Close() }()
	portal := conn.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
	prop := func(obj dbus.BusObject, name string) (dbus.Variant, bool) {
		v, err := obj.GetProperty(name)
		return v, err == nil
	}
	u32 := func(v dbus.Variant, ok bool) uint32 {
		if !ok {
			return 0
		}
		n, _ := v.Value().(uint32)
		return n
	}
	r.screenCastVersion = u32(prop(portal, "org.freedesktop.portal.ScreenCast.version"))
	r.sourceTypes = u32(prop(portal, "org.freedesktop.portal.ScreenCast.AvailableSourceTypes"))
	r.cursorModes = u32(prop(portal, "org.freedesktop.portal.ScreenCast.AvailableCursorModes"))
	r.globalShortcutsVersion = u32(prop(portal, "org.freedesktop.portal.GlobalShortcuts.version"))

	has := func(name string) bool {
		var owned bool
		return conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, name).Store(&owned) == nil && owned
	}
	if r.sniWatcher = has("org.kde.StatusNotifierWatcher"); r.sniWatcher {
		watcher := conn.Object("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher")
		if v, ok := prop(watcher, "org.kde.StatusNotifierWatcher.IsStatusNotifierHostRegistered"); ok {
			r.sniHost, _ = v.Value().(bool)
		}
	}
	if r.kwin = has("org.kde.KWin"); r.kwin {
		var info string
		if conn.Object("org.kde.KWin", "/KWin").Call("org.kde.KWin.supportInformation", 0).Store(&info) == nil {
			r.kwinVersion = parseKWinVersion(info)
		}
		var xml string
		if conn.Object("org.kde.KWin", "/Scripting").Call("org.freedesktop.DBus.Introspectable.Introspect", 0).Store(&xml) == nil {
			r.kwinScripting = strings.Contains(xml, "org.kde.kwin.Scripting")
		}
	}
	return r
}
