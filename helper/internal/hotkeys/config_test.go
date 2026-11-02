// SPDX-License-Identifier: AGPL-3.0-only

package hotkeys

import (
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
	if len(b) != 3 || b[0].Action != Curtain || b[0].Trigger != Defaults[Curtain] || b[2].Action != Stop {
		t.Fatalf("defaults: %+v", b)
	}
	for _, binding := range b {
		if norm, err := ParseTrigger(binding.Trigger); err != nil || norm != binding.Trigger {
			t.Errorf("default %s %q is not normalized (%q, %v)", binding.Action, binding.Trigger, norm, err)
		}
	}
}

func TestParseOverridesAndOff(t *testing.T) {
	b, err := Parse(map[string]string{"curtain": "Super+F9", "pause": "", "stop": "off"})
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != 1 || b[0] != (Binding{Action: Curtain, Trigger: "LOGO+F9"}) {
		t.Fatalf("%+v", b)
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]map[string]string{
		"unknown action":  {"mute": "Ctrl+Alt+M"},
		"both use":        {"pause": "Ctrl+Alt+Shift+H"},
		"shortcuts.stop:": {"stop": "x"},
	}
	for want, cfg := range cases {
		if _, err := Parse(cfg); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%v) = %v, want an error with %q", cfg, err, want)
		}
	}
}
