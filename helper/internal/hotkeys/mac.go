// SPDX-License-Identifier: AGPL-3.0-only

package hotkeys

import (
	"fmt"
	"strings"
)

// On macOS the shortcuts are Carbon hot keys (RegisterEventHotKey, in the sidecar's agent),
// which need no Accessibility permission. This maps the XDG triggers that Parse returns to
// Carbon's virtual key codes and modifier bits, so the config file is the same on both.

// Carbon modifier bits (Events.h).
const (
	macCmd     uint32 = 1 << 8
	macShift   uint32 = 1 << 9
	macOption  uint32 = 1 << 11
	macControl uint32 = 1 << 12
)

// macModifiers: Super is the Command key, Alt the Option key.
var macModifiers = map[string]uint32{"CTRL": macControl, "ALT": macOption, "SHIFT": macShift, "LOGO": macCmd}

// macKeys are the virtual key codes of the ANSI layout (kVK_*). Carbon hot keys name the key
// position, so on another layout a letter is where it is on a US keyboard.
var macKeys = map[string]uint32{
	"a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
	"c": 0x08, "v": 0x09, "b": 0x0b, "q": 0x0c, "w": 0x0d, "e": 0x0e, "r": 0x0f, "y": 0x10,
	"t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19,
	"7": 0x1a, "8": 0x1c, "0": 0x1d, "o": 0x1f, "u": 0x20, "i": 0x22, "p": 0x23, "l": 0x25,
	"j": 0x26, "k": 0x28, "n": 0x2d, "m": 0x2e,
	"Return": 0x24, "Tab": 0x30, "space": 0x31, "BackSpace": 0x33, "Escape": 0x35,
	"Delete": 0x75, "Home": 0x73, "End": 0x77, "Page_Up": 0x74, "Prior": 0x74,
	"Page_Down": 0x79, "Next": 0x79, "Left": 0x7b, "Right": 0x7c, "Down": 0x7d, "Up": 0x7e,
	"F1": 0x7a, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61, "F7": 0x62,
	"F8": 0x64, "F9": 0x65, "F10": 0x6d, "F11": 0x67, "F12": 0x6f, "F13": 0x69, "F14": 0x6b,
	"F15": 0x71, "F16": 0x6a, "F17": 0x40, "F18": 0x4f, "F19": 0x50, "F20": 0x5a,
}

// MacKey is a trigger in the XDG format (from ParseTrigger) as a Carbon key code and
// modifiers. Keys macOS has no code for (F21–F24, most XKB names) are an error.
func MacKey(trigger string) (keyCode, modifiers uint32, err error) {
	parts := strings.Split(trigger, "+")
	for _, m := range parts[:len(parts)-1] {
		bit, ok := macModifiers[m]
		if !ok {
			return 0, 0, fmt.Errorf("shortcut %s: unknown modifier %s", trigger, m)
		}
		modifiers |= bit
	}
	key := parts[len(parts)-1]
	code, ok := macKeys[key]
	if !ok {
		return 0, 0, fmt.Errorf("shortcut %s: macOS has no key %s (use a letter, a digit, F1–F20 or an arrow)", trigger, key)
	}
	return code, modifiers, nil
}

// MacTrigger is a trigger as macOS menus write it: ⌃⌥⇧H.
func MacTrigger(trigger string) string {
	parts := strings.Split(trigger, "+")
	var b strings.Builder
	// The order of macOS menus: Control, Option, Shift, Command.
	for _, m := range []struct{ name, sym string }{{"CTRL", "⌃"}, {"ALT", "⌥"}, {"SHIFT", "⇧"}, {"LOGO", "⌘"}} {
		for _, p := range parts[:len(parts)-1] {
			if p == m.name {
				b.WriteString(m.sym)
			}
		}
	}
	key := parts[len(parts)-1]
	if len(key) == 1 {
		key = strings.ToUpper(key)
	}
	return b.String() + key
}
