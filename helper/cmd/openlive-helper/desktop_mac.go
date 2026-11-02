// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/henriquefps/openlive/helper/internal/hotkeys"
	"github.com/henriquefps/openlive/helper/internal/i18n"
	"github.com/henriquefps/openlive/helper/internal/macagent"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/notify"
	"github.com/henriquefps/openlive/helper/internal/sidecar"
	"github.com/henriquefps/openlive/helper/internal/tray"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The helper on the macOS desktop: the menu bar item, the notifications and the global
// shortcuts come from the sidecar's agent (internal/macagent), wired to the same state, menu
// and actions as the Linux tray and shortcuts. This builds on every unix so Linux CI tests
// it against a fake agent.

// menuBar is the tray on macOS: the agent shows tray.Menu as a menu bar item.
type menuBar struct {
	agent *macagent.Agent
	cat   i18n.Catalog
}

func (m menuBar) Update(s tray.Status) { _ = m.agent.SetMenu(macMenu(s, m.cat)) }

// macMenu is the Linux tray's menu, icon and tooltip for the agent. The curtain has an icon
// of its own: it is the state the streamer most needs to see at a glance.
func macMenu(s tray.Status, cat i18n.Catalog) sidecar.Menu {
	icon := string(tray.IconFor(s))
	if s.State == protocol.HelperStatePaused && s.PauseReason == protocol.PauseReasonPrivacyCurtain {
		icon = "curtain"
	}
	m := sidecar.Menu{Icon: icon, Tooltip: tray.StatusLine(s, cat)}
	for _, it := range tray.Menu(s, cat) {
		m.Items = append(m.Items, sidecar.MenuItem{ID: it.ID, Label: it.Label, Enabled: it.Enabled && it.Action != "", Separator: it.Separator, Checked: it.Checked})
	}
	return m
}

// macReadyWait is how long the "ready" notification waits for the notification permission,
// so that it shows through UserNotifications when allowed.
var macReadyWait = 3 * time.Second

// startMac starts the agent. Notifications go through osascript until the agent says
// UserNotifications may be used, and again if it stops; without an agent (no sidecar, one
// of another protocol) the helper runs without the menu bar item and the shortcuts, and the
// web controls it as before. It runs before the desktop loop starts, so it sets d.tray.
func (d *desktop) startMac(ctx context.Context, bin string, showIcon, minimized bool, bindings []hotkeys.Binding) {
	var fallback notify.Notifier
	if n, err := notify.NewOSAScript(); err == nil {
		fallback = n
		d.notes.SetNotifier(n)
	} else {
		d.log.Info("no osascript notifications", "err", err)
	}
	// settled closes when the notification channel is known (the agent's first permission
	// state, or its end), so a notification told before then is not lost to the wrong channel.
	settled := make(chan struct{})
	var once sync.Once
	ready := func() {
		once.Do(func() {
			close(settled)
			if !minimized {
				d.notes.Post(notify.Ready, notify.Args{})
			}
		})
	}
	var err error
	if bin == "" {
		bin, err = media.FindSidecar()
	}
	var a *macagent.Agent
	if err == nil {
		a, err = macagent.Start(ctx, bin, d.log)
	}
	if err != nil {
		d.log.Warn("no menu bar icon or global shortcuts: running headless, the web still controls the helper", "err", err)
		ready()
		return
	}
	if showIcon {
		d.tray = menuBar{agent: a, cat: d.cat}
		d.update()
		d.log.Info("menu bar icon shown")
	}
	time.AfterFunc(macReadyWait, ready)
	go d.macEvents(ctx, a, fallback, ready)
	if len(bindings) > 0 {
		go d.bindMacShortcuts(ctx, a, bindings, settled)
	}
}

// macEvents runs the agent's clicks, key presses and permission changes until it stops.
func (d *desktop) macEvents(ctx context.Context, a *macagent.Agent, fallback notify.Notifier, ready func()) {
	for {
		select {
		case id := <-a.Clicks():
			d.enqueue(func() {
				if act, ok := tray.ActionOf(id, d.status, d.cat); ok {
					d.run(act)
				}
			})
		case act := <-a.Pressed():
			d.log.Debug("shortcut pressed", "action", act)
			d.enqueue(func() { d.shortcut(hotkeys.Action(act)) })
		case n := <-a.Notifications():
			if n.State == sidecar.NotificationsAuthorized {
				d.notes.SetNotifier(a)
				d.log.Info("notifications through UserNotifications", "bundle", n.Bundle)
			} else {
				if fallback != nil {
					d.notes.SetNotifier(fallback)
				}
				d.log.Info("notifications through osascript", "reason", macNotificationsReason(n))
			}
			ready()
		case <-a.Done():
			if fallback != nil {
				d.notes.SetNotifier(fallback)
			}
			d.enqueue(func() { d.tray = nil })
			if ctx.Err() == nil {
				d.log.Warn("the menu bar agent stopped: running headless, the web still controls the helper")
			}
			return
		}
	}
}

func macNotificationsReason(n sidecar.Notifications) string {
	switch n.State {
	case sidecar.NotificationsDenied:
		return "turned off for the helper in System Settings > Notifications"
	case sidecar.NotificationsUnavailable:
		return "the agent does not run from the app bundle (macos-capture/bundle.sh)"
	}
	return n.State + " " + n.Error
}

// bindMacShortcuts registers the config's shortcuts as Carbon hot keys. One another app
// holds is reported in the log and in a notification, as is one macOS has no key for.
func (d *desktop) bindMacShortcuts(ctx context.Context, a *macagent.Agent, bindings []hotkeys.Binding, settled <-chan struct{}) {
	var mac []sidecar.HotkeyBinding
	for _, b := range bindings {
		code, mods, err := hotkeys.MacKey(b.Trigger)
		if err != nil {
			d.log.Warn("global shortcut not bound: fix the config file", "action", b.Action, "err", err)
			continue
		}
		mac = append(mac, sidecar.HotkeyBinding{Action: string(b.Action), Trigger: b.Trigger, KeyCode: code, Modifiers: mods})
	}
	if len(mac) == 0 {
		return
	}
	res, err := a.BindHotkeys(ctx, mac)
	if err != nil {
		if ctx.Err() == nil && !errors.Is(err, macagent.ErrClosed) {
			d.log.Warn("global shortcuts not bound", "err", err)
		}
		return
	}
	select {
	case <-settled:
	case <-ctx.Done():
		return
	}
	var bound []string
	for _, r := range res {
		trigger := hotkeys.MacTrigger(r.Trigger)
		switch {
		case r.OK:
			bound = append(bound, r.Action+"="+trigger)
		case r.Conflict:
			d.log.Warn("global shortcut taken by another app: pick another one in the config file", "action", r.Action, "shortcut", trigger)
			d.notes.Tell(d.cat.T(i18n.ShortcutConflict, trigger), "", false)
		default:
			d.log.Warn("global shortcut not bound", "action", r.Action, "shortcut", trigger, "err", r.Error)
		}
	}
	if len(bound) > 0 {
		d.log.Info("global shortcuts bound", "shortcuts", strings.Join(bound, " "))
	}
}
