// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/hotkeys"
	"github.com/henriquefps/openlive/helper/internal/i18n"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/notify"
	"github.com/henriquefps/openlive/helper/internal/sidecar"
	"github.com/henriquefps/openlive/helper/internal/tray"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The macOS desktop runs here against a fake agent: this test binary, started again with
// fakeAgentEnv set, plays "openlive-capture agent". It clicks the curtain item once the menu
// offers it, presses the curtain shortcut once it is bound, refuses any shortcut on X as
// taken, and logs every message it gets.

const (
	fakeAgentEnv    = "OPENLIVE_FAKE_AGENT"
	fakeAgentLogEnv = "OPENLIVE_FAKE_AGENT_LOG"
)

func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv(fakeAgentEnv); ok {
		os.Exit(fakeAgent())
	}
	os.Exit(m.Run())
}

func fakeAgent() int {
	conn := os.NewFile(3, "helper")
	logf, err := os.OpenFile(os.Getenv(fakeAgentLogEnv), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 3
	}
	defer func() { _ = logf.Close() }()
	_ = sidecar.WriteJSON(conn, sidecar.TypeHello, sidecar.Hello{ProtocolVersion: sidecar.ProtocolVersion, Version: "fake", OS: "test"})
	_ = sidecar.WriteJSON(conn, sidecar.TypeNotifications, sidecar.Notifications{State: sidecar.NotificationsAuthorized})
	clicked, pressed := false, false
	for {
		m, err := sidecar.Read(conn)
		if err != nil || m.Type == sidecar.TypeStop {
			return 0
		}
		_, _ = logf.Write(append([]byte{byte(m.Type)}, append(m.Payload, '\n')...))
		switch m.Type {
		case sidecar.TypeMenu:
			var menu sidecar.Menu
			_ = m.Decode(&menu)
			for _, it := range menu.Items {
				if it.Checked != nil && it.Enabled && !*it.Checked && !clicked {
					clicked = true
					_ = sidecar.WriteJSON(conn, sidecar.TypeMenuClick, sidecar.MenuClick{ID: it.ID})
				}
				if it.Checked != nil && *it.Checked && !pressed {
					// The curtain is down: its shortcut lifts it.
					pressed = true
					_ = sidecar.WriteJSON(conn, sidecar.TypeHotkey, sidecar.Hotkey{Action: string(hotkeys.Curtain)})
				}
			}
		case sidecar.TypeHotkeys:
			var h sidecar.Hotkeys
			_ = m.Decode(&h)
			var res sidecar.HotkeysBound
			for _, b := range h.Bindings {
				ok := b.KeyCode != 0x07
				res.Results = append(res.Results, sidecar.HotkeyResult{Action: b.Action, Trigger: b.Trigger, OK: ok, Conflict: !ok})
			}
			_ = sidecar.WriteJSON(conn, sidecar.TypeHotkeysBound, res)
		}
	}
}

func TestMacMenu(t *testing.T) {
	cat := i18n.Catalog{Lang: i18n.En}
	s := tray.Status{Online: true, Instance: "https://openlive.example", State: protocol.HelperStatePaused, PauseReason: protocol.PauseReasonPrivacyCurtain, Room: "Games", Viewers: 2}
	m := macMenu(s, cat)
	if m.Icon != "curtain" || m.Tooltip != tray.StatusLine(s, cat) {
		t.Errorf("icon %q tooltip %q", m.Icon, m.Tooltip)
	}
	items := tray.Menu(s, cat)
	if len(m.Items) != len(items) {
		t.Fatalf("%d items, want %d", len(m.Items), len(items))
	}
	for i, it := range items {
		got := m.Items[i]
		if got.ID != it.ID || got.Label != it.Label || got.Separator != it.Separator || got.Enabled != (it.Enabled && it.Action != "") {
			t.Errorf("item %d: %+v from %+v", i, got, it)
		}
	}
	if m := macMenu(tray.Status{State: protocol.HelperStateLive}, cat); m.Icon != "live" {
		t.Errorf("live icon %q", m.Icon)
	}
	if m := macMenu(tray.Status{State: protocol.HelperStatePaused, PauseReason: protocol.PauseReasonUser}, cat); m.Icon != "paused" {
		t.Errorf("paused icon %q", m.Icon)
	}
}

// The menu bar item and the shortcuts run the same actions as the Linux tray: a click on the
// curtain lowers it, its shortcut lifts it, and a shortcut another app holds is reported.
func TestDesktopMacAgent(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "agent.log")
	t.Setenv(fakeAgentEnv, "1")
	t.Setenv(fakeAgentLogEnv, logPath)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeSession{done: make(chan struct{})}
	c, hub := newTestController(func(context.Context, protocol.HelperStartStreamPayload, media.Source) (session, error) { return s, nil })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cat := i18n.Catalog{Lang: i18n.En}
	d := &desktop{
		ctl: c, cat: cat, log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		events:    make(chan func(), 64),
		status:    tray.Status{Instance: "https://openlive.example", State: protocol.HelperStateIdle},
		roomNames: map[string]string{},
		notes:     &notify.Center{Policy: notify.NewPolicy(notify.Settings{}), Catalog: cat},
	}
	c.observe = d.observe
	bindings, err := hotkeys.Parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	d.startMac(ctx, exe, true, true, bindings)
	go d.loop(ctx)
	c.attach(ctx, hub)
	hub.status(t, protocol.HelperStateIdle)
	c.handle(ctx, hub, cmd("h_1", &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame}))
	hub.reply(t, "h_1")
	hub.status(t, protocol.HelperStateLive)
	if st := hub.status(t, protocol.HelperStatePaused); *st.Stream.PauseReason != protocol.PauseReasonPrivacyCurtain {
		t.Fatalf("menu click: %+v", st)
	}
	hub.status(t, protocol.HelperStateLive)

	// The log fills as the agent reads: wait for the conflict's notification.
	var log string
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		b, _ := os.ReadFile(logPath)
		log = string(b)
		lifted := strings.Index(log, `"icon":"curtain"`) < strings.LastIndex(log, `"icon":"live"`)
		if strings.Contains(log, "used by another app") && strings.Contains(log, `"icon":"curtain"`) && lifted {
			break
		}
	}
	var menus []sidecar.Menu
	var notes []sidecar.Notify
	var hk sidecar.Hotkeys
	for line := range strings.SplitSeq(strings.TrimSpace(log), "\n") {
		switch sidecar.Type(line[0]) {
		case sidecar.TypeMenu:
			var m sidecar.Menu
			_ = json.Unmarshal([]byte(line[1:]), &m)
			menus = append(menus, m)
		case sidecar.TypeNotify:
			var n sidecar.Notify
			_ = json.Unmarshal([]byte(line[1:]), &n)
			notes = append(notes, n)
		case sidecar.TypeHotkeys:
			_ = json.Unmarshal([]byte(line[1:]), &hk)
		}
	}
	var icons []string
	for _, m := range menus {
		if len(icons) == 0 || icons[len(icons)-1] != m.Icon {
			icons = append(icons, m.Icon)
		}
	}
	if got := strings.Join(icons, " "); !strings.HasPrefix(got, "idle live curtain live") {
		t.Errorf("icons %s", got)
	}
	if len(hk.Bindings) != 3 || hk.Bindings[0].Action != "curtain" || hk.Bindings[0].KeyCode != 0x04 || hk.Bindings[0].Modifiers != 0x1a00 {
		t.Errorf("hotkeys %+v", hk)
	}
	var conflict bool
	for _, n := range notes {
		conflict = conflict || strings.Contains(n.Title, "⌃⌥⇧X")
	}
	if !conflict {
		t.Errorf("no conflict notification in %+v", notes)
	}
}
