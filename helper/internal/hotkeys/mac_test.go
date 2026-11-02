// SPDX-License-Identifier: AGPL-3.0-only

package hotkeys

import "testing"

func TestMacKey(t *testing.T) {
	cases := []struct {
		in        string
		code, mod uint32
		menu      string
	}{
		// The defaults: ⌃⌥⇧ plus a letter.
		{"Ctrl+Alt+Shift+H", 0x04, macControl | macOption | macShift, "⌃⌥⇧H"},
		{"ctrl+option+shift+x", 0x07, macControl | macOption | macShift, "⌃⌥⇧X"},
		{"Cmd+Shift+7", 0x1a, macCmd | macShift, "⇧⌘7"},
		{"Super+F9", 0x65, macCmd, "⌘F9"},
		{"Ctrl+Alt+Page_Down", 0x79, macControl | macOption, "⌃⌥Page_Down"},
	}
	for _, c := range cases {
		trigger, err := ParseTrigger(c.in)
		if err != nil {
			t.Fatal(err)
		}
		code, mod, err := MacKey(trigger)
		if err != nil || code != c.code || mod != c.mod {
			t.Errorf("MacKey(%s) = %#x, %#x, %v; want %#x, %#x", trigger, code, mod, err, c.code, c.mod)
		}
		if got := MacTrigger(trigger); got != c.menu {
			t.Errorf("MacTrigger(%s) = %s, want %s", trigger, got, c.menu)
		}
	}
	for _, bad := range []string{"CTRL+F24", "CTRL+Pause", "CTRL+Print"} {
		if _, _, err := MacKey(bad); err == nil {
			t.Errorf("MacKey(%s): want an error", bad)
		}
	}
	// Every default maps.
	for a, d := range Defaults {
		trigger, _ := ParseTrigger(d)
		if _, _, err := MacKey(trigger); err != nil {
			t.Errorf("default %s: %v", a, err)
		}
	}
}
