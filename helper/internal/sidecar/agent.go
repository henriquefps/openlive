// SPDX-License-Identifier: AGPL-3.0-only

package sidecar

// The agent's messages. "openlive-capture agent --fd 3" is the helper's presence on the macOS
// desktop while "run" is up: the menu bar item, the notifications and the global shortcuts
// (helper/internal/macagent). It speaks the same framing and hello as a capture; the helper
// sends the menu, notifications and shortcuts, the agent sends clicks and key presses back.

// MenuItem is one entry of the menu bar item's menu (tray.Item on the wire).
type MenuItem struct {
	ID        int32  `json:"id"`
	Label     string `json:"label,omitempty"`
	Enabled   bool   `json:"enabled,omitempty"`
	Separator bool   `json:"separator,omitempty"`
	// Checked is a toggle's state; nil for plain items.
	Checked *bool `json:"checked,omitempty"`
}

// Menu is the whole menu bar item: its icon ("idle", "live", "paused", "curtain"), the
// tooltip and the menu. Each one replaces the previous.
type Menu struct {
	Icon    string     `json:"icon"`
	Tooltip string     `json:"tooltip"`
	Items   []MenuItem `json:"items"`
}

// MenuClick is a click on a menu item. The helper maps the id against the menu it holds
// now, so a click on a menu that changed under the pointer does nothing.
type MenuClick struct {
	ID int32 `json:"id"`
}

// Notify shows one notification. ID names it: a later Notify with the same ID replaces it.
// A transient one is removed from Notification Center after a while.
type Notify struct {
	ID        uint32 `json:"id"`
	Title     string `json:"title"`
	Body      string `json:"body,omitempty"`
	Critical  bool   `json:"critical,omitempty"`
	Transient bool   `json:"transient,omitempty"`
}

// Notification authorization states (Notifications.State).
const (
	// NotificationsAuthorized: notifications go through UserNotifications.
	NotificationsAuthorized = "authorized"
	// NotificationsDenied: the person turned them off for the app (System Settings >
	// Notifications).
	NotificationsDenied = "denied"
	// NotificationsUnavailable: the agent does not run from an app bundle, which
	// UserNotifications needs.
	NotificationsUnavailable = "unavailable"
)

// Notifications is the agent's notification permission, sent once it is known and again
// when it changes.
type Notifications struct {
	State  string `json:"state"`
	Bundle string `json:"bundle,omitempty"`
	Error  string `json:"error,omitempty"`
}

// HotkeyBinding is one global shortcut as Carbon's RegisterEventHotKey takes it.
type HotkeyBinding struct {
	Action string `json:"action"`
	// Trigger is the configured trigger, for messages ("CTRL+ALT+SHIFT+h").
	Trigger string `json:"trigger"`
	// KeyCode is a virtual key code (kVK_*); Modifiers are Carbon's modifier bits
	// (cmdKey, shiftKey, optionKey, controlKey).
	KeyCode   uint32 `json:"keyCode"`
	Modifiers uint32 `json:"modifiers"`
}

// Hotkeys replaces every global shortcut with these.
type Hotkeys struct {
	Bindings []HotkeyBinding `json:"bindings"`
}

// HotkeyResult says whether one binding was registered.
type HotkeyResult struct {
	Action  string `json:"action"`
	Trigger string `json:"trigger"`
	OK      bool   `json:"ok"`
	// Conflict: another app holds the same shortcut.
	Conflict bool   `json:"conflict,omitempty"`
	Error    string `json:"error,omitempty"`
}

// HotkeysBound answers Hotkeys.
type HotkeysBound struct {
	Results []HotkeyResult `json:"results"`
}

// Hotkey is a pressed global shortcut.
type Hotkey struct {
	Action string `json:"action"`
}
