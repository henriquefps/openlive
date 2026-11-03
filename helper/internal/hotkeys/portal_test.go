// SPDX-License-Identifier: AGPL-3.0-only

package hotkeys

import (
	"testing"

	"github.com/godbus/dbus/v5"
)

// The portal says Activated when a shortcut goes down and Deactivated when it comes up, which
// is what push-to-talk needs.
func TestEventOf(t *testing.T) {
	const handle = dbus.ObjectPath("/org/freedesktop/portal/desktop/session/1/openlive")
	sig := func(name string, body ...any) *dbus.Signal {
		return &dbus.Signal{Name: shortcutsIface + "." + name, Body: body}
	}
	cases := []struct {
		name string
		sig  *dbus.Signal
		want Event
		ok   bool
	}{
		{"press", sig("Activated", handle, "talk", uint64(1), map[string]dbus.Variant{}), Event{Action: Talk}, true},
		{"release", sig("Deactivated", handle, "talk", uint64(2), map[string]dbus.Variant{}), Event{Action: Talk, Released: true}, true},
		{"other session", sig("Activated", dbus.ObjectPath("/other"), "talk"), Event{}, false},
		{"other signal", sig("ShortcutsChanged", handle, "talk"), Event{}, false},
		{"short body", sig("Activated", handle), Event{}, false},
	}
	for _, tc := range cases {
		got, ok := eventOf(tc.sig, handle)
		if ok != tc.ok || got != tc.want {
			t.Errorf("%s: %+v, %v; want %+v, %v", tc.name, got, ok, tc.want, tc.ok)
		}
	}
}
