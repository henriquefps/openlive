// SPDX-License-Identifier: AGPL-3.0-only

// Package tray shows the helper in the system tray through StatusNotifierItem
// (D-Bus): KDE Plasma, GNOME with the AppIndicator extension, waybar and most other Linux
// panels. The icon says idle, live or paused; the menu shows the status and controls the
// stream. Without a tray host the helper runs headless.
package tray

import (
	"github.com/henriquefps/openlive/helper/internal/i18n"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Status is what the tray shows.
type Status struct {
	// Online: the hub socket is up, so the web can control the helper.
	Online   bool
	Instance string
	State    protocol.HelperState
	// PauseReason says why a paused stream is paused.
	PauseReason protocol.PauseReason
	Room        string
	Preset      string
	Viewers     int
}

// Icon is the tray icon's variant.
type Icon string

const (
	IconIdle   Icon = "idle"
	IconLive   Icon = "live"
	IconPaused Icon = "paused"
)

// IconFor is the icon for s: live while publishing, paused under a pause or the curtain.
func IconFor(s Status) Icon {
	switch s.State {
	case protocol.HelperStateLive:
		return IconLive
	case protocol.HelperStatePaused:
		return IconPaused
	}
	return IconIdle
}

// Action is what a menu item or a shortcut asks for.
type Action string

const (
	Pause      Action = "pause"
	Resume     Action = "resume"
	CurtainOn  Action = "curtain_on"
	CurtainOff Action = "curtain_off"
	Stop       Action = "stop"
	Open       Action = "open"
	Pair       Action = "pair"
	Quit       Action = "quit"
)

// Item ids in the DBusMenu (0 is the root).
const (
	idStatus  int32 = 1
	idDetail1 int32 = 2
	idDetail2 int32 = 3
	idDetail3 int32 = 4
	idDetail4 int32 = 5
	idSep1    int32 = 10
	idPause   int32 = 11
	idCurtain int32 = 12
	idStop    int32 = 13
	idSep2    int32 = 20
	idOpen    int32 = 21
	idPair    int32 = 22
	idSep3    int32 = 30
	idQuit    int32 = 31
)

// Item is one menu entry.
type Item struct {
	ID        int32
	Label     string
	Enabled   bool
	Separator bool
	// Checked is a toggle's state; nil for plain items.
	Checked *bool
	// Action is what clicking the item does ("" for the status lines).
	Action Action
}

func streaming(s Status) bool {
	return s.State == protocol.HelperStateLive || s.State == protocol.HelperStatePaused
}

func curtained(s Status) bool {
	return s.State == protocol.HelperStatePaused && s.PauseReason == protocol.PauseReasonPrivacyCurtain
}

// StatusLine is the first line of the menu and the tooltip.
func StatusLine(s Status, cat i18n.Catalog) string {
	if !s.Online && !streaming(s) {
		return cat.T(i18n.StatusOffline, s.Instance)
	}
	switch s.State {
	case protocol.HelperStateStarting:
		return cat.T(i18n.StatusStarting)
	case protocol.HelperStateLive:
		return cat.T(i18n.StatusLive)
	case protocol.HelperStatePaused:
		if curtained(s) {
			return cat.T(i18n.StatusCurtain)
		}
		return cat.T(i18n.StatusPaused)
	case protocol.HelperStateStopping:
		return cat.T(i18n.StatusStopping)
	case protocol.HelperStateError:
		return cat.T(i18n.StatusError)
	}
	return cat.T(i18n.StatusIdle)
}

// Details are the status lines under the first one: instance, and while streaming the
// room, preset and viewers.
func Details(s Status, cat i18n.Catalog) []string {
	out := []string{cat.T(i18n.StatusInstance, s.Instance)}
	if streaming(s) || s.State == protocol.HelperStateStarting {
		if s.Room != "" {
			out = append(out, cat.T(i18n.StatusRoom, s.Room))
		}
		if s.Preset != "" {
			out = append(out, cat.T(i18n.StatusPreset, s.Preset))
		}
	}
	if streaming(s) {
		out = append(out, cat.T(i18n.StatusViewers, s.Viewers))
	}
	return out
}

// Menu is the tray menu for s. The stream controls follow the helper's state: pause and
// the curtain only while streaming, stop also while a start is in progress (it aborts it).
func Menu(s Status, cat i18n.Catalog) []Item {
	items := []Item{{ID: idStatus, Label: StatusLine(s, cat)}}
	for i, d := range Details(s, cat) {
		items = append(items, Item{ID: idDetail1 + int32(i), Label: d})
	}
	pause := Item{ID: idPause, Label: cat.T(i18n.MenuPause), Action: Pause, Enabled: streaming(s)}
	if s.State == protocol.HelperStatePaused {
		pause.Label, pause.Action = cat.T(i18n.MenuResume), Resume
	}
	on := curtained(s)
	curtain := Item{ID: idCurtain, Label: cat.T(i18n.MenuCurtainOn), Action: CurtainOn, Enabled: streaming(s), Checked: &on}
	if on {
		curtain.Action = CurtainOff
	}
	stop := Item{ID: idStop, Label: cat.T(i18n.MenuStop), Action: Stop,
		Enabled: streaming(s) || s.State == protocol.HelperStateStarting}
	items = append(items,
		Item{ID: idSep1, Separator: true},
		pause, curtain, stop,
		Item{ID: idSep2, Separator: true},
		Item{ID: idOpen, Label: cat.T(i18n.MenuOpen), Action: Open, Enabled: true},
		Item{ID: idPair, Label: cat.T(i18n.MenuPair), Action: Pair, Enabled: true},
		Item{ID: idSep3, Separator: true},
		Item{ID: idQuit, Label: cat.T(i18n.MenuQuit), Action: Quit, Enabled: true},
	)
	return items
}

// ActionOf is the action of clicking item id in s's menu; ok is false for a disabled or
// unknown item (a click on a menu that changed under the pointer).
func ActionOf(id int32, s Status, cat i18n.Catalog) (Action, bool) {
	for _, it := range Menu(s, cat) {
		if it.ID == id {
			return it.Action, it.Enabled && it.Action != ""
		}
	}
	return "", false
}

// Toggle is what a shortcut's toggle means in s: the curtain shortcut lifts the curtain
// when it is down; the pause shortcut resumes a paused stream. ok is false when there is
// no stream to act on.
func Toggle(curtain bool, s Status) (Action, bool) {
	if !streaming(s) {
		return "", false
	}
	if curtain {
		if curtained(s) {
			return CurtainOff, true
		}
		return CurtainOn, true
	}
	if s.State == protocol.HelperStatePaused {
		return Resume, true
	}
	return Pause, true
}
