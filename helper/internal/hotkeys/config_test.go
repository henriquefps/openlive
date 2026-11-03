// SPDX-License-Identifier: AGPL-3.0-only

package hotkeys

import (
	"slices"
	"strings"
	"testing"
)

func TestParseTrigger(t *testing.T) {
	ok := map[string]string{
		"Ctrl+Alt+Shift+H":   "CTRL+ALT+SHIFT+h",
		"shift+ctrl+alt+h":   "CTRL+ALT+SHIFT+h",
		"Super+F9":           "LOGO+F9",
		"meta + f12":         "LOGO+F12",
		"Control+Alt+Pause":  "CTRL+ALT+Pause",
		"CTRL+SHIFT+7":       "CTRL+SHIFT+7",
		"ctrl+alt+Page_Down": "CTRL+ALT+Page_Down",
	}
	for in, want := range ok {
		got, err := ParseTrigger(in)
		if err != nil || got != want {
			t.Errorf("ParseTrigger(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "h", "Ctrl+", "Hyper+h", "Ctrl+Ctrl+h", "Ctrl+Alt+é", "Ctrl+F99"} {
		if got, err := ParseTrigger(bad); err == nil {
			t.Errorf("ParseTrigger(%q) = %q, want an error", bad, got)
		}
	}
}

func TestParseDefaults(t *testing.T) {
	b, err := Parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != 6 || b[0].Action != Curtain || b[0].Trigger != Defaults[Curtain] || b[2].Action != Stop || b[3].Action != Talk || b[5].Action != Deafen {
		t.Fatalf("defaults: %+v", b)
	}
	for _, binding := range b {
		if norm, err := ParseTrigger(binding.Trigger); err != nil || norm != binding.Trigger {
			t.Errorf("default %s %q is not normalized (%q, %v)", binding.Action, binding.Trigger, norm, err)
		}
	}
}

func TestParseOverridesAndOff(t *testing.T) {
	b, err := Parse(map[string]string{"curtain": "Super+F9", "pause": "", "stop": "off", "talk": "Ctrl+Alt+F10", "mute": "none", "deafen": "off"})
	if err != nil {
		t.Fatal(err)
	}
	want := []Binding{{Action: Curtain, Trigger: "LOGO+F9"}, {Action: Talk, Trigger: "CTRL+ALT+F10"}}
	if !slices.Equal(b, want) {
		t.Fatalf("%+v, want %+v", b, want)
	}
}

func TestVoiceActions(t *testing.T) {
	for _, a := range []Action{Talk, Mute, Deafen} {
		if !a.IsVoice() {
			t.Errorf("%s is a voice action", a)
		}
	}
	for _, a := range []Action{Curtain, Pause, Stop} {
		if a.IsVoice() {
			t.Errorf("%s is not a voice action", a)
		}
	}
	// Voice shortcuts can be turned off alone, the others keep their defaults.
	b, err := Parse(map[string]string{"talk": "off", "mute": "off", "deafen": "off"})
	if err != nil || len(b) != 3 {
		t.Fatalf("%+v, %v", b, err)
	}
	// A voice trigger that collides with another action is refused.
	if _, err := Parse(map[string]string{"mute": "Ctrl+Alt+Shift+H"}); err == nil || !strings.Contains(err.Error(), "both use") {
		t.Errorf("collision: %v", err)
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]map[string]string{
		"unknown action":  {"record": "Ctrl+Alt+M"},
		"both use":        {"pause": "Ctrl+Alt+Shift+H"},
		"shortcuts.stop:": {"stop": "x"},
	}
	for want, cfg := range cases {
		if _, err := Parse(cfg); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%v) = %v, want an error with %q", cfg, err, want)
		}
	}
}
