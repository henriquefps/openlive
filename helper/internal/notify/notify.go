// SPDX-License-Identifier: AGPL-3.0-only

// Package notify tells the streamer what the helper is doing through desktop notifications
// (org.freedesktop.Notifications) and short sounds:
// the stream started or stopped, the network is unstable, someone started watching.
package notify

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/henriquefps/openlive/helper/internal/i18n"
)

// Event is something the streamer may want to hear about.
type Event string

const (
	Started      Event = "started"
	Stopped      Event = "stopped"
	Dropped      Event = "dropped"
	Unstable     Event = "unstable"
	ViewerJoined Event = "viewer_joined"
	Curtain      Event = "curtain"
	// Ready: "run" started from a launcher; the helper has no window, so say where it is.
	Ready Event = "ready"
)

// Settings is the "notifications" block of the config file. A nil field takes its default.
type Settings struct {
	// Enabled turns every desktop notification off when false (default true).
	Enabled *bool `json:"enabled,omitempty"`
	// Sounds plays the in-app sound set with the notices (default true): false mutes them.
	Sounds *bool `json:"sounds,omitempty"`
	// Per event (defaults: on, except viewerJoined).
	Started      *bool `json:"started,omitempty"`
	Stopped      *bool `json:"stopped,omitempty"`
	Unstable     *bool `json:"unstable,omitempty"`
	ViewerJoined *bool `json:"viewerJoined,omitempty"`
	Curtain      *bool `json:"curtain,omitempty"`
}

// Policy is what to show and play, resolved from Settings.
type Policy struct {
	Enabled bool
	Sounds  bool
	Events  map[Event]bool
}

// NewPolicy resolves s with the web's defaults: someone watching is off.
func NewPolicy(s Settings) Policy {
	on := func(b *bool, def bool) bool {
		if b == nil {
			return def
		}
		return *b
	}
	stopped := on(s.Stopped, true)
	return Policy{
		Enabled: on(s.Enabled, true),
		Sounds:  on(s.Sounds, true),
		Events: map[Event]bool{
			Started: on(s.Started, true),
			Stopped: stopped,
			// A drop is a stop the streamer did not ask for, and it plays the alert.
			Dropped:      stopped,
			Unstable:     on(s.Unstable, true),
			ViewerJoined: on(s.ViewerJoined, false),
			Curtain:      on(s.Curtain, true),
			Ready:        true,
		},
	}
}

// soundOf is the sound each event plays: the same set the web uses for its notices.
var soundOf = map[Event]Sound{
	Started:      SoundStart,
	Stopped:      SoundStop,
	Dropped:      SoundAlert,
	Unstable:     SoundAlert,
	ViewerJoined: SoundViewer,
}

// Decide says whether ev shows a notification and which sound it plays ("" for none).
func (p Policy) Decide(ev Event) (show bool, sound Sound) {
	if !p.Events[ev] {
		return false, ""
	}
	if p.Sounds {
		sound = soundOf[ev]
	}
	return p.Enabled, sound
}

// minGap keeps repeated events from flooding the desktop.
var minGap = map[Event]time.Duration{
	Unstable:     2 * time.Minute,
	ViewerJoined: 30 * time.Second,
}

// Args fill an event's text.
type Args struct {
	Source  string
	Room    string
	Viewers int
	// On is the curtain's new state.
	On bool
	// Err says why a stream dropped.
	Err string
}

// Notification is one desktop notification.
type Notification struct {
	Summary string
	Body    string
	// Icon is an icon name or an absolute file path.
	Icon     string
	Critical bool
	// Transient notifications skip the notification history.
	Transient bool
	// ReplacesID updates a notification still on screen (0 for a new one).
	ReplacesID uint32
}

// Notifier shows notifications (DBus; a fake in tests).
type Notifier interface {
	Notify(n Notification) (uint32, error)
}

// Player plays one sound (a command-line player; a fake in tests).
type Player interface {
	Play(s Sound) error
}

// Center turns events into notifications and sounds by the policy.
type Center struct {
	Policy  Policy
	Catalog i18n.Catalog
	// Notifier may also be set later with SetNotifier, once the server answered.
	Notifier Notifier
	Player   Player
	// Icon is the notification icon (the helper's app icon).
	Icon string
	Log  *slog.Logger
	Now  func() time.Time

	mu   sync.Mutex
	last map[Event]time.Time
	// streamID is the notification about the stream state, replaced as it changes.
	streamID uint32
}

// SetNotifier sets the notifier after the Center is in use.
func (c *Center) SetNotifier(n Notifier) {
	c.mu.Lock()
	c.Notifier = n
	c.mu.Unlock()
}

func (c *Center) notifier() Notifier {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Notifier
}

// Post shows ev and plays its sound, as the policy says.
func (c *Center) Post(ev Event, a Args) {
	show, sound := c.Policy.Decide(ev)
	if !show && sound == "" {
		return
	}
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	c.mu.Lock()
	if gap := minGap[ev]; gap > 0 {
		if t, ok := c.last[ev]; ok && now.Sub(t) < gap {
			c.mu.Unlock()
			return
		}
	}
	if c.last == nil {
		c.last = map[Event]time.Time{}
	}
	c.last[ev] = now
	c.mu.Unlock()

	if sound != "" && c.Player != nil {
		if err := c.Player.Play(sound); err != nil {
			c.logf("play sound", "sound", sound, "err", err)
		}
	}
	notifier := c.notifier()
	if !show || notifier == nil {
		return
	}
	n := c.render(ev, a)
	n.Icon = c.Icon
	stream := ev == Started || ev == Stopped || ev == Dropped || ev == Curtain
	c.mu.Lock()
	if stream {
		n.ReplacesID = c.streamID
	}
	c.mu.Unlock()
	id, err := notifier.Notify(n)
	if err != nil {
		c.logf("desktop notification", "event", ev, "err", err)
		return
	}
	if stream {
		c.mu.Lock()
		c.streamID = id
		c.mu.Unlock()
	}
}

// Tell shows a notification the person asked for (the pairing code, its result), whatever
// the policy; without a notification server it goes to the log.
func (c *Center) Tell(summary, body string, critical bool) {
	if n := c.notifier(); n != nil {
		if _, err := n.Notify(Notification{Summary: summary, Body: body, Icon: c.Icon, Critical: critical}); err == nil {
			return
		}
	}
	if c.Log != nil {
		c.Log.Info(summary, "detail", body)
	}
}

func (c *Center) render(ev Event, a Args) Notification {
	t := c.Catalog.T
	switch ev {
	case Started:
		return Notification{Summary: t(i18n.NotifyStarted), Body: t(i18n.NotifyStartedBody, orDash(a.Source), orDash(a.Room))}
	case Stopped:
		return Notification{Summary: t(i18n.NotifyStopped), Body: t(i18n.NotifyStoppedBody), Transient: true}
	case Dropped:
		return Notification{Summary: t(i18n.NotifyDropped), Body: a.Err, Critical: true}
	case Unstable:
		return Notification{Summary: t(i18n.NotifyUnstable), Body: t(i18n.NotifyUnstableBody)}
	case ViewerJoined:
		return Notification{Summary: t(i18n.NotifyViewer), Body: t(i18n.NotifyViewerBody, a.Viewers), Transient: true}
	case Ready:
		return Notification{Summary: t(i18n.NotifyReady), Body: t(i18n.NotifyReadyBody), Transient: true}
	case Curtain:
		key := i18n.NotifyCurtainOff
		if a.On {
			key = i18n.NotifyCurtainOn
		}
		return Notification{Summary: t(key), Transient: true}
	}
	return Notification{Summary: fmt.Sprint(ev)}
}

func (c *Center) logf(msg string, args ...any) {
	if c.Log != nil {
		c.Log.Debug(msg, args...)
	}
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}
