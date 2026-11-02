// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"errors"
	"os/exec"
	"strings"
)

// OSAScript shows notifications on macOS through AppleScript's "display notification". Until
// the helper ships as an app bundle (UserNotifications needs one), they show as Script
// Editor's; ReplacesID and the icon are not supported.
type OSAScript struct {
	path string
}

// NewOSAScript finds osascript.
func NewOSAScript() (*OSAScript, error) {
	p, err := exec.LookPath("osascript")
	if err != nil {
		return nil, errors.New("notifications: osascript not found")
	}
	return &OSAScript{path: p}, nil
}

// appleString quotes s as an AppleScript string literal.
func appleString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", " ").Replace(s) + `"`
}

// script is the AppleScript that shows n.
func (n Notification) script() string {
	return "display notification " + appleString(n.Body) + " with title " + appleString(n.Summary)
}

// Notify implements Notifier; it does not wait for osascript.
func (o *OSAScript) Notify(n Notification) (uint32, error) {
	cmd := exec.Command(o.path, "-e", n.script())
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	go func() { _ = cmd.Wait() }()
	return 0, nil
}
