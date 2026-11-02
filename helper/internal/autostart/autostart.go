// SPDX-License-Identifier: AGPL-3.0-only

// Package autostart starts the helper with the desktop session (optional
// and off by default) through an XDG autostart entry: KDE, GNOME and most other Linux
// desktops (and systemd's xdg-autostart-generator) read ~/.config/autostart/*.desktop. On
// macOS it is a LaunchAgent (launchagent.go).
// It also writes the helper's application entry when no package installed one: the
// desktop portals only know apps by their .desktop file.
package autostart

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// FileName is the entry's file name, the helper's application id.
const FileName = "dev.hfps.OpenliveHelper.desktop"

// Dir is $XDG_CONFIG_HOME/autostart (default ~/.config/autostart), or ~/Library/LaunchAgents
// on macOS.
func Dir() (string, error) {
	if launchAgents {
		return launchAgentsDir()
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "autostart"), nil
}

// Entry is what the autostart entry runs.
type Entry struct {
	// Binary is the helper's absolute path.
	Binary string
	// Args follow the binary: run --instance <url> --minimized, plus the config flags.
	Args    []string
	Name    string
	Comment string
	// Env is the LaunchAgent's environment (macOS only; the app sets its version and locale).
	Env map[string]string
	// Launcher renders the application entry (menus, portals) instead of the autostart one.
	Launcher bool
}

// Desktop renders the entry as a .desktop file.
func (e Entry) Desktop() string {
	words := []string{quote(e.Binary)}
	for _, a := range e.Args {
		words = append(words, quote(a))
	}
	var b strings.Builder
	b.WriteString("[Desktop Entry]\n")
	b.WriteString("Type=Application\n")
	fmt.Fprintf(&b, "Name=%s\n", oneLine(e.Name))
	fmt.Fprintf(&b, "Comment=%s\n", oneLine(e.Comment))
	fmt.Fprintf(&b, "Exec=%s\n", strings.Join(words, " "))
	b.WriteString("Icon=dev.hfps.OpenliveHelper\n")
	b.WriteString("Terminal=false\n")
	if e.Launcher {
		b.WriteString("Categories=AudioVideo;Video;\n")
		b.WriteString("StartupNotify=false\n")
		return b.String()
	}
	b.WriteString("NoDisplay=true\n")
	b.WriteString("X-GNOME-Autostart-enabled=true\n")
	// Start after the panel, so the tray icon has a host to register with.
	b.WriteString("X-KDE-autostart-phase=2\n")
	return b.String()
}

// quote escapes one Exec argument (Desktop Entry spec, "The Exec key"): arguments with
// reserved characters are double-quoted with ", `, $ and \ escaped, and % is doubled.
func quote(arg string) string {
	arg = strings.ReplaceAll(arg, "%", "%%")
	if arg != "" && !strings.ContainsAny(arg, " \t\n\"'\\><~|&;$*?#()`") {
		return arg
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range arg {
		if r == '"' || r == '`' || r == '$' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	// The .desktop parser unescapes \\ once more inside string values.
	return strings.ReplaceAll(b.String(), `\`, `\\`)
}

func oneLine(s string) string { return strings.NewReplacer("\n", " ", "\r", " ").Replace(s) }

// dataDirs are $XDG_DATA_HOME then $XDG_DATA_DIRS, with the spec's defaults.
func dataDirs() (home string, all []string, err error) {
	home = os.Getenv("XDG_DATA_HOME")
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", nil, err
		}
		home = filepath.Join(h, ".local", "share")
	}
	dirs := os.Getenv("XDG_DATA_DIRS")
	if dirs == "" {
		dirs = "/usr/local/share:/usr/share"
	}
	return home, append([]string{home}, filepath.SplitList(dirs)...), nil
}

// EnsureLauncher writes the application entry (e.Launcher) and its icon to
// $XDG_DATA_HOME unless a package installed them in a system data dir. It rewrites a
// stale entry of its own (the binary moved). written says whether anything changed.
func EnsureLauncher(e Entry, iconSVG string) (written bool, err error) {
	if launchAgents {
		// macOS has no .desktop files; an app bundle carries its own metadata.
		return false, nil
	}
	e.Launcher = true
	home, all, err := dataDirs()
	if err != nil {
		return false, err
	}
	for _, d := range all[1:] {
		if _, err := os.Stat(filepath.Join(d, "applications", FileName)); err == nil && d != home {
			return false, nil
		}
	}
	files := map[string]string{
		filepath.Join(home, "applications", FileName):                                                                e.Desktop(),
		filepath.Join(home, "icons", "hicolor", "scalable", "apps", strings.TrimSuffix(FileName, ".desktop")+".svg"): iconSVG,
	}
	for path, content := range files {
		if old, err := os.ReadFile(path); err == nil && string(old) == content {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return written, err
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return written, err
		}
		written = true
	}
	return written, nil
}

// Enable writes the entry into dir and returns its path.
func Enable(dir string, e Entry) (string, error) {
	if !filepath.IsAbs(e.Binary) {
		return "", fmt.Errorf("autostart: the helper path %q is not absolute", e.Binary)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, entryFile())
	tmp := path + ".tmp"
	content := e.Desktop()
	if launchAgents {
		content = e.LaunchAgent(logPath())
	}
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return "", err
	}
	return path, os.Rename(tmp, path)
}

// Disable removes the entry; it is not an error when there is none.
func Disable(dir string) (removed bool, err error) {
	err = os.Remove(filepath.Join(dir, entryFile()))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// Read returns the entry's Exec line (the LaunchAgent's program), or ok false when autostart
// is off.
func Read(dir string) (exec string, ok bool, err error) {
	raw, err := os.ReadFile(filepath.Join(dir, entryFile()))
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if launchAgents {
		return launchAgentProgram(raw), true, nil
	}
	for line := range strings.SplitSeq(string(raw), "\n") {
		if v, found := strings.CutPrefix(line, "Exec="); found {
			return v, true, nil
		}
	}
	return "", true, nil
}
