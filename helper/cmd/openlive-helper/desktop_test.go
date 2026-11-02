// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/autostart"
	"github.com/henriquefps/openlive/helper/internal/i18n"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/notify"
	"github.com/henriquefps/openlive/helper/internal/store"
	"github.com/henriquefps/openlive/helper/internal/tray"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The tray and the shortcuts run the web's commands; the web sees the result as helper.status.
func TestControllerLocalCommandsReachTheWeb(t *testing.T) {
	s := &fakeSession{done: make(chan struct{})}
	c, hub := newTestController(func(context.Context, protocol.HelperStartStreamPayload, media.Source) (session, error) { return s, nil })
	var seen []protocol.HelperState
	var mu sync.Mutex
	c.observe = func(p protocol.Payload) {
		if st, ok := p.(protocol.HelperStatusPayload); ok {
			mu.Lock()
			seen = append(seen, st.State)
			mu.Unlock()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.attach(ctx, hub)
	hub.status(t, protocol.HelperStateIdle)

	// Nothing to pause yet: logged, nothing sent.
	c.pause(ctx, true, protocol.PauseReasonUser)

	c.handle(ctx, hub, cmd("h_1", &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame}))
	hub.reply(t, "h_1")
	hub.status(t, protocol.HelperStateLive)

	c.pause(ctx, true, protocol.PauseReasonUser)
	if st := hub.status(t, protocol.HelperStatePaused); *st.Stream.PauseReason != protocol.PauseReasonUser {
		t.Fatalf("tray pause = %+v", st)
	}
	c.pause(ctx, true, protocol.PauseReasonPrivacyCurtain)
	if st := hub.status(t, protocol.HelperStatePaused); *st.Stream.PauseReason != protocol.PauseReasonPrivacyCurtain {
		t.Fatalf("curtain = %+v", st)
	}
	c.pause(ctx, false, "")
	hub.status(t, protocol.HelperStateLive)
	c.stop(ctx)
	hub.status(t, protocol.HelperStateStopping)
	hub.status(t, protocol.HelperStateIdle)
	hub.mu.Lock()
	for _, f := range hub.frames {
		if f.reply {
			t.Errorf("a local command replied on the hub: %+v", f)
		}
	}
	hub.mu.Unlock()
	mu.Lock()
	defer mu.Unlock()
	if len(seen) < 6 || seen[len(seen)-1] != protocol.HelperStateIdle {
		t.Errorf("observed %v", seen)
	}
}

type recordingNotifier struct{ got []notify.Notification }

func (r *recordingNotifier) Notify(n notify.Notification) (uint32, error) {
	r.got = append(r.got, n)
	return uint32(len(r.got)), nil
}

func (r *recordingNotifier) summaries() string {
	var out []string
	for _, n := range r.got {
		out = append(out, n.Summary)
	}
	return strings.Join(out, " | ")
}

func status(state protocol.HelperState, reason protocol.PauseReason) protocol.HelperStatusPayload {
	p := protocol.HelperStatusPayload{DeviceID: "d_pc", State: state}
	if state != protocol.HelperStateIdle && state != protocol.HelperStateError {
		p.Stream = &protocol.HelperStreamStatus{RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame}
		if reason != "" {
			p.Stream.PauseReason = &reason
		}
	}
	return p
}

func TestDesktopNotifiesTransitions(t *testing.T) {
	n := &recordingNotifier{}
	yes := true
	d := &desktop{
		cat:       i18n.Catalog{Lang: i18n.En},
		log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		status:    tray.Status{Instance: "https://openlive.example", State: protocol.HelperStateIdle},
		roomNames: map[string]string{},
		notes: &notify.Center{
			Policy:   notify.NewPolicy(notify.Settings{ViewerJoined: &yes}),
			Catalog:  i18n.Catalog{Lang: i18n.En},
			Notifier: n,
		},
	}
	d.events = make(chan func(), 64)
	run := func() {
		for {
			select {
			case fn := <-d.events:
				fn()
			default:
				return
			}
		}
	}
	d.streamStarted("r_1", "Games", "Firefox")
	d.observe(status(protocol.HelperStateStarting, ""))
	d.observe(status(protocol.HelperStateLive, ""))
	run()
	if d.status.Room != "Games" || d.status.Preset != "1080p60" {
		t.Fatalf("status %+v", d.status)
	}
	d.viewers(1)
	d.viewers(1)
	d.viewers(0)
	d.observe(status(protocol.HelperStatePaused, protocol.PauseReasonPrivacyCurtain))
	d.observe(status(protocol.HelperStateLive, ""))
	d.observe(status(protocol.HelperStatePaused, protocol.PauseReasonUser))
	d.observe(status(protocol.HelperStateLive, ""))
	run()
	// Ten seconds of a target cut in half: the network is unstable, once.
	for i := range 30 {
		kbps := 8000
		if i >= 5 {
			kbps = 2000
		}
		d.observe(protocol.HelperStatsPayload{TargetBitrateKbps: kbps})
	}
	d.observe(status(protocol.HelperStateStopping, ""))
	d.observe(status(protocol.HelperStateIdle, ""))
	d.observe(status(protocol.HelperStateStarting, ""))
	d.observe(status(protocol.HelperStateLive, ""))
	d.observe(status(protocol.HelperStateError, ""))
	run()
	want := "You are live | Someone started watching | Privacy curtain on: viewers see \"Paused\". | " +
		"Privacy curtain lifted: viewers see your screen again. | Network unstable | Stream stopped | You are live | Your stream dropped"
	if got := n.summaries(); got != want {
		t.Errorf("notifications\n got %s\nwant %s", got, want)
	}
	if !strings.Contains(n.got[0].Body, "Firefox") || !strings.Contains(n.got[0].Body, "Games") {
		t.Errorf("started body %q", n.got[0].Body)
	}
	if d.status.Viewers != 0 || d.status.State != protocol.HelperStateError {
		t.Errorf("final status %+v", d.status)
	}
}

func TestAutostartEntry(t *testing.T) {
	dir := t.TempDir()
	cfg := store.Config{}
	cfg.Remember(store.Instance{URL: "https://openlive.example", DeviceID: "d_pc", PairedAt: time.Now()})
	if err := store.SaveConfig(store.ConfigPath(dir), cfg); err != nil {
		t.Fatal(err)
	}
	e, err := autostartEntry(&common{configDir: dir, tokenFile: true})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"run", "--instance", "https://openlive.example", "--minimized", "--config-dir", dir, "--insecure-token-file"}
	if strings.Join(e.Args, " ") != strings.Join(want, " ") || !filepath.IsAbs(e.Binary) {
		t.Fatalf("entry %+v", e)
	}
	if _, err := autostartEntry(&common{configDir: dir, instance: "https://other.example"}); err == nil || !strings.Contains(err.Error(), "not paired with https://other.example") {
		t.Errorf("unpaired instance: %v", err)
	}
	if _, err := autostartEntry(&common{configDir: t.TempDir()}); err == nil || !strings.Contains(err.Error(), "not paired") {
		t.Errorf("no pairing: %v", err)
	}

	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var out strings.Builder
	if err := runAutostart([]string{"enable", "--config-dir", dir}, &out); err != nil {
		t.Fatal(err)
	}
	adir, _ := autostart.Dir()
	raw, err := os.ReadFile(filepath.Join(adir, autostart.FileName))
	if err != nil || !strings.Contains(string(raw), "run --instance https://openlive.example --minimized --config-dir "+dir) {
		t.Fatalf("entry file: %v\n%s", err, raw)
	}
	if err := runAutostart([]string{"disable"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "no longer starts") {
		t.Errorf("output %q", out.String())
	}
}
