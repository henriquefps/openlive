// SPDX-License-Identifier: AGPL-3.0-only

// Package hotkeys binds the helper's global shortcuts (stop the stream,
// privacy curtain; plus pause/resume) through the XDG GlobalShortcuts portal, which KDE
// Plasma implements. Where the portal is missing the helper runs without shortcuts. On
// macOS the same config becomes Carbon hot keys (mac.go).
package hotkeys

import (
	"fmt"
	"slices"
	"strings"
)

// Action is what a shortcut does.
type Action string

const (
	Curtain Action = "curtain"
	Pause   Action = "pause"
	Stop    Action = "stop"
)

// Actions lists every action in menu order.
var Actions = []Action{Curtain, Pause, Stop}

// Defaults are the preferred triggers. Ctrl+Alt+Shift with a letter is free in the common
// desktops, games, browsers and voice apps (Discord takes Ctrl+Shift+M/D, OBS binds nothing
// by default, Ctrl+Alt+F-keys switch virtual terminals); three modifiers also keep "stop"
// from firing by accident. The desktop may still ask the person to confirm or change them.
var Defaults = map[Action]string{
	Curtain: "CTRL+ALT+SHIFT+h",
	Pause:   "CTRL+ALT+SHIFT+p",
	Stop:    "CTRL+ALT+SHIFT+x",
}

// Binding is one shortcut to bind.
type Binding struct {
	Action Action
	// Trigger is the preferred trigger in the XDG shortcuts format ("CTRL+ALT+SHIFT+h").
	Trigger string
}

// modifiers maps the accepted spellings to the XDG shortcuts names, in output order.
var modifiers = []struct {
	name    string
	aliases []string
}{
	{"CTRL", []string{"ctrl", "control"}},
	{"ALT", []string{"alt", "option", "opt"}},
	{"SHIFT", []string{"shift"}},
	{"LOGO", []string{"logo", "super", "meta", "win", "cmd", "command"}},
}

// ParseTrigger normalizes a trigger like "Ctrl+Alt+Shift+H" or "super+F9" to the XDG
// shortcuts format (modifiers in capitals, then one key: a lowercase letter, a digit, F1–F24
// or an XKB key name). It needs at least one modifier: a bare key would steal it from every app.
func ParseTrigger(s string) (string, error) {
	parts := strings.Split(strings.TrimSpace(s), "+")
	if len(parts) < 2 {
		return "", fmt.Errorf("shortcut %q: want modifiers and a key, like Ctrl+Alt+Shift+H", s)
	}
	seen := map[string]bool{}
	for _, p := range parts[:len(parts)-1] {
		p = strings.ToLower(strings.TrimSpace(p))
		found := ""
		for _, m := range modifiers {
			if slices.Contains(m.aliases, p) {
				found = m.name
			}
		}
		if found == "" {
			return "", fmt.Errorf("shortcut %q: unknown modifier %q (use Ctrl, Alt, Shift or Super)", s, p)
		}
		if seen[found] {
			return "", fmt.Errorf("shortcut %q: %s twice", s, found)
		}
		seen[found] = true
	}
	key := strings.TrimSpace(parts[len(parts)-1])
	switch {
	case key == "":
		return "", fmt.Errorf("shortcut %q: no key", s)
	case len(key) == 1 && isAlnum(key[0]):
		key = strings.ToLower(key)
	case isFunctionKey(key):
		key = strings.ToUpper(key)
	case looksLikeFunctionKey(key):
		return "", fmt.Errorf("shortcut %q: no key %s (F1–F24)", s, key)
	default:
		for _, r := range key {
			if !isAlnum(byte(r)) && r != '_' {
				return "", fmt.Errorf("shortcut %q: unknown key %q", s, key)
			}
		}
	}
	var out []string
	for _, m := range modifiers {
		if seen[m.name] {
			out = append(out, m.name)
		}
	}
	return strings.Join(append(out, key), "+"), nil
}

func isAlnum(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9'
}

func looksLikeFunctionKey(k string) bool {
	var n int
	_, err := fmt.Sscanf(strings.ToUpper(k), "F%d", &n)
	return err == nil
}

func isFunctionKey(k string) bool {
	var n int
	if _, err := fmt.Sscanf(strings.ToUpper(k), "F%d", &n); err != nil {
		return false
	}
	return fmt.Sprintf("F%d", n) == strings.ToUpper(k) && n >= 1 && n <= 24
}

// Parse turns the config file's "shortcuts" block (action → trigger) into bindings. A
// missing action takes its default; "" or "off" turns it off. Unknown actions and bad or
// repeated triggers are errors, so a typo does not silently leave a shortcut unbound.
func Parse(cfg map[string]string) ([]Binding, error) {
	for name := range cfg {
		if !slices.Contains(Actions, Action(name)) {
			return nil, fmt.Errorf("shortcuts: unknown action %q (want curtain, pause or stop)", name)
		}
	}
	var out []Binding
	used := map[string]Action{}
	for _, a := range Actions {
		raw, set := cfg[string(a)]
		if !set {
			raw = Defaults[a]
		}
		if t := strings.ToLower(strings.TrimSpace(raw)); t == "" || t == "off" || t == "none" {
			continue
		}
		trigger, err := ParseTrigger(raw)
		if err != nil {
			return nil, fmt.Errorf("shortcuts.%s: %w", a, err)
		}
		if other, dup := used[trigger]; dup {
			return nil, fmt.Errorf("shortcuts: %s and %s both use %s", other, a, trigger)
		}
		used[trigger] = a
		out = append(out, Binding{Action: a, Trigger: trigger})
	}
	return out, nil
}
