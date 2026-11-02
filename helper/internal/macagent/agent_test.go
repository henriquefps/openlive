// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package macagent

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/notify"
	"github.com/henriquefps/openlive/helper/internal/sidecar"
)

// The agent runs here as a fake: this test binary, started again with fakeEnv set, plays
// "openlive-capture agent". It logs what it got, one JSON line each, and answers as the
// Swift agent does: a menu item click and a key press after the menu, the permission
// state at start, and a conflict for any shortcut on X.

const (
	fakeEnv    = "OPENLIVE_FAKE_AGENT"
	fakeLogEnv = "OPENLIVE_FAKE_AGENT_LOG"
)

func TestMain(m *testing.M) {
	if mode, ok := os.LookupEnv(fakeEnv); ok {
		os.Exit(fakeAgent(mode, os.Args[1:]))
	}
	os.Exit(m.Run())
}

func fakeLog(typ sidecar.Type, payload []byte) {
	f, err := os.OpenFile(os.Getenv(fakeLogEnv), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	b, _ := json.Marshal(map[string]any{"type": int(typ), "payload": json.RawMessage(orNull(payload))})
	_, _ = f.Write(append(b, '\n'))
}

func orNull(b []byte) []byte {
	if len(b) == 0 {
		return []byte("null")
	}
	return b
}

func fakeAgent(mode string, args []string) int {
	if strings.Join(args, " ") != "agent --fd 3" {
		return 2
	}
	conn := os.NewFile(3, "helper")
	proto := sidecar.ProtocolVersion
	if mode == "oldproto" {
		proto = 1
	}
	_ = sidecar.WriteJSON(conn, sidecar.TypeHello, sidecar.Hello{ProtocolVersion: proto, Version: "fake", OS: "test"})
	_ = sidecar.WriteJSON(conn, sidecar.TypeNotifications, sidecar.Notifications{State: sidecar.NotificationsAuthorized, Bundle: "dev.hfps.OpenliveHelper"})
	for {
		m, err := sidecar.Read(conn)
		if err != nil {
			return 0
		}
		fakeLog(m.Type, m.Payload)
		switch m.Type {
		case sidecar.TypeStop:
			return 0
		case sidecar.TypeMenu:
			_ = sidecar.WriteJSON(conn, sidecar.TypeMenuClick, sidecar.MenuClick{ID: 12})
		case sidecar.TypeHotkeys:
			var h sidecar.Hotkeys
			_ = m.Decode(&h)
			var res sidecar.HotkeysBound
			for _, b := range h.Bindings {
				r := sidecar.HotkeyResult{Action: b.Action, Trigger: b.Trigger, OK: b.KeyCode != 0x07}
				if !r.OK {
					r.Conflict, r.Error = true, "another app uses this shortcut"
				}
				res.Results = append(res.Results, r)
			}
			_ = sidecar.WriteJSON(conn, sidecar.TypeHotkeysBound, res)
			_ = sidecar.WriteJSON(conn, sidecar.TypeHotkey, sidecar.Hotkey{Action: "curtain"})
		}
	}
}

func fakeAgentBin(t *testing.T, mode string) string {
	t.Helper()
	t.Setenv(fakeEnv, mode)
	logPath := filepath.Join(t.TempDir(), "agent.log")
	t.Setenv(fakeLogEnv, logPath)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

func within[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatalf("no %s", what)
	}
	var zero T
	return zero
}

func TestAgent(t *testing.T) {
	bin := fakeAgentBin(t, "ok")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := Start(ctx, bin, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	if n := within(t, a.Notifications(), "permission state"); n.State != sidecar.NotificationsAuthorized {
		t.Errorf("notifications %+v", n)
	}

	on := false
	if err := a.SetMenu(sidecar.Menu{Icon: "live", Tooltip: "Live", Items: []sidecar.MenuItem{{ID: 12, Label: "Curtain", Enabled: true, Checked: &on}}}); err != nil {
		t.Fatal(err)
	}
	if id := within(t, a.Clicks(), "click"); id != 12 {
		t.Errorf("click %d", id)
	}

	res, err := a.BindHotkeys(ctx, []sidecar.HotkeyBinding{
		{Action: "curtain", Trigger: "CTRL+ALT+SHIFT+h", KeyCode: 0x04, Modifiers: 0x1a00},
		{Action: "stop", Trigger: "CTRL+ALT+SHIFT+x", KeyCode: 0x07, Modifiers: 0x1a00},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 2 || !res[0].OK || res[1].OK || !res[1].Conflict {
		t.Errorf("results %+v", res)
	}
	if act := within(t, a.Pressed(), "key press"); act != "curtain" {
		t.Errorf("pressed %s", act)
	}

	id1, err := a.Notify(notify.Notification{Summary: "Live", Body: "Room"})
	if err != nil {
		t.Fatal(err)
	}
	id2, _ := a.Notify(notify.Notification{Summary: "Stopped", ReplacesID: id1})
	id3, _ := a.Notify(notify.Notification{Summary: "Viewer", Transient: true})
	if id1 == 0 || id2 != id1 || id3 == id1 {
		t.Errorf("ids %d %d %d", id1, id2, id3)
	}

	cancel()
	within(t, a.Done(), "exit")
	b, err := os.ReadFile(os.Getenv(fakeLogEnv))
	if err != nil {
		t.Fatal(err)
	}
	var types []int
	var notes []sidecar.Notify
	for line := range strings.SplitSeq(strings.TrimSpace(string(b)), "\n") {
		var l struct {
			Type    int             `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal([]byte(line), &l); err != nil {
			t.Fatal(err)
		}
		types = append(types, l.Type)
		if sidecar.Type(l.Type) == sidecar.TypeNotify {
			var n sidecar.Notify
			_ = json.Unmarshal(l.Payload, &n)
			notes = append(notes, n)
		}
	}
	want := []int{int(sidecar.TypeMenu), int(sidecar.TypeHotkeys), int(sidecar.TypeNotify), int(sidecar.TypeNotify), int(sidecar.TypeNotify), int(sidecar.TypeStop)}
	if len(types) != len(want) {
		t.Fatalf("messages %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("messages %v, want %v", types, want)
		}
	}
	if notes[0].Title != "Live" || notes[0].Body != "Room" || notes[1].ID != notes[0].ID || !notes[2].Transient {
		t.Errorf("notifications %+v", notes)
	}
	if _, err := a.Notify(notify.Notification{Summary: "late"}); err == nil {
		t.Error("notify after close: want an error")
	}
}

func TestAgentOldProtocol(t *testing.T) {
	bin := fakeAgentBin(t, "oldproto")
	_, err := Start(context.Background(), bin, nil)
	if err == nil || !strings.Contains(err.Error(), "rebuild them together") {
		t.Errorf("err = %v", err)
	}
}

func TestAgentMissing(t *testing.T) {
	if _, err := Start(context.Background(), filepath.Join(t.TempDir(), "nothing"), nil); err == nil {
		t.Error("want an error")
	}
}
