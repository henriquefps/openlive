// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"image/jpeg"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/media"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// recordingHub is a hubSender that keeps every frame the controller sends.
type recordingHub struct {
	mu     sync.Mutex
	frames []sent
	wake   chan struct{}
}

type sent struct {
	id      string
	reply   bool
	payload protocol.Payload
}

func newRecordingHub() *recordingHub { return &recordingHub{wake: make(chan struct{}, 1)} }

func (h *recordingHub) Reply(_ context.Context, id string, p protocol.Payload) error {
	h.add(sent{id: id, reply: true, payload: p})
	return nil
}

func (h *recordingHub) Send(_ context.Context, p protocol.Payload) error {
	h.add(sent{payload: p})
	return nil
}

func (h *recordingHub) add(s sent) {
	h.mu.Lock()
	h.frames = append(h.frames, s)
	h.mu.Unlock()
	select {
	case h.wake <- struct{}{}:
	default:
	}
}

// take removes and returns the first frame matching, waiting up to 2 s.
func (h *recordingHub) take(t *testing.T, match func(sent) bool) sent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		h.mu.Lock()
		for i, f := range h.frames {
			if match(f) {
				h.frames = append(h.frames[:i], h.frames[i+1:]...)
				h.mu.Unlock()
				return f
			}
		}
		h.mu.Unlock()
		select {
		case <-h.wake:
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			t.Fatalf("no matching frame; have %+v", h.frames)
		}
	}
}

func (h *recordingHub) reply(t *testing.T, id string) protocol.Payload {
	t.Helper()
	return h.take(t, func(s sent) bool { return s.reply && s.id == id }).payload
}

func (h *recordingHub) status(t *testing.T, state protocol.HelperState) protocol.HelperStatusPayload {
	t.Helper()
	return h.take(t, func(s sent) bool {
		st, ok := s.payload.(protocol.HelperStatusPayload)
		return ok && st.State == state
	}).payload.(protocol.HelperStatusPayload)
}

type fakeBackend struct{ sources []media.Source }

func (b *fakeBackend) ListSources(context.Context) ([]media.Source, error) { return b.sources, nil }
func (b *fakeBackend) Start(context.Context, media.Source, media.Profile) (media.Stream, error) {
	return nil, errors.New("not used")
}

type fakeSession struct {
	mu      sync.Mutex
	paused  []bool
	presets []protocol.Preset
	stopped bool
	done    chan struct{}
	err     error
}

func (s *fakeSession) StreamID() string { return "st_1" }
func (s *fakeSession) SetPaused(_ context.Context, paused bool, _ protocol.PauseReason) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.paused = append(s.paused, paused)
	return nil
}
func (s *fakeSession) SetPreset(_ context.Context, p protocol.Preset) error {
	if p == protocol.PresetNative {
		return &api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodePresetNotAllowed, Preset: &p}}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.presets = append(s.presets, p)
	return nil
}
func (s *fakeSession) Stats() protocol.HelperStatsPayload {
	return protocol.HelperStatsPayload{StreamID: "st_1", FPS: 60, Width: 1920, Height: 1080}
}
func (s *fakeSession) Done() <-chan struct{} { return s.done }
func (s *fakeSession) Err() error            { return s.err }
func (s *fakeSession) Stop(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopped = true
	return nil
}

var testSource = media.Source{ID: "test", Kind: media.SourceTest, Label: "Test pattern", HasAudio: true}

func newTestController(start startFunc) (*controller, *recordingHub) {
	backend := &fakeBackend{sources: []media.Source{
		testSource,
		{ID: media.PortalWindowID, Kind: media.SourceWindow, Label: "Choose a window"},
		{ID: "w_1", Kind: media.SourceWindow, Label: "Game", AppName: "game", Width: 1280, Height: 720, HasAudio: true},
	}}
	c := newController("d_pc", backend, start, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.statsEvery = 20 * time.Millisecond
	hub := newRecordingHub()
	return c, hub
}

func cmd(id string, p protocol.Payload) api.Command { return api.Command{ID: id, Payload: p} }

func TestControllerSendsItsStateOnAttach(t *testing.T) {
	c, hub := newTestController(nil)
	c.attach(context.Background(), hub)
	if st := hub.status(t, protocol.HelperStateIdle); st.DeviceID != "d_pc" || st.Stream != nil {
		t.Fatalf("status = %+v", st)
	}
}

func TestControllerListsSourcesWithThumbnails(t *testing.T) {
	c, hub := newTestController(nil)
	ctx := context.Background()
	c.handle(ctx, hub, cmd("h_1", &protocol.HelperListSourcesPayload{DeviceID: "d_pc", Thumbnails: true}))
	sources := hub.reply(t, "h_1").(protocol.HelperSourcesPayload).Sources
	if len(sources) != 3 {
		t.Fatalf("sources = %+v", sources)
	}
	// The schema has no test kind: the test pattern is a screen.
	if s := sources[0]; s.SourceID != "test" || s.Kind != protocol.SourceKindScreen || !s.HasAudio {
		t.Errorf("test source = %+v", s)
	}
	if s := sources[2]; s.Kind != protocol.SourceKindWindow || *s.AppName != "game" || *s.Width != 1280 {
		t.Errorf("window = %+v", s)
	}
	thumb := hub.take(t, func(s sent) bool { _, ok := s.payload.(protocol.HelperSourceThumbnailPayload); return ok }).payload.(protocol.HelperSourceThumbnailPayload)
	if thumb.SourceID != "test" || thumb.MIMEType != "image/jpeg" || thumb.Width != thumbWidth {
		t.Fatalf("thumbnail = %+v", thumb)
	}
	raw, err := base64.StdEncoding.DecodeString(thumb.Data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jpeg.Decode(strings.NewReader(string(raw))); err != nil || len(thumb.Data) > 262144 {
		t.Fatalf("not a JPEG within the limit: %v (%d)", err, len(thumb.Data))
	}
}

func TestControllerStreamLifecycle(t *testing.T) {
	s := &fakeSession{done: make(chan struct{})}
	var got protocol.HelperStartStreamPayload
	c, hub := newTestController(func(_ context.Context, req protocol.HelperStartStreamPayload, src media.Source) (session, error) {
		if src.ID != "test" {
			t.Errorf("source = %+v", src)
		}
		got = req
		return s, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.attach(ctx, hub)
	hub.status(t, protocol.HelperStateIdle)

	start := &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame, Audio: true}
	c.handle(ctx, hub, cmd("h_1", start))
	if st := hub.status(t, protocol.HelperStateStarting); st.Stream.RoomID != "r_1" || st.Stream.StreamID != nil {
		t.Fatalf("starting = %+v", st)
	}
	if _, ok := hub.reply(t, "h_1").(protocol.AckPayload); !ok {
		t.Fatal("start not acked")
	}
	if st := hub.status(t, protocol.HelperStateLive); *st.Stream.StreamID != "st_1" || st.Stream.Preset != protocol.PresetGame {
		t.Fatalf("live = %+v", st)
	}
	if got.RoomID != "r_1" || !got.Audio {
		t.Fatalf("start request = %+v", got)
	}
	stats := hub.take(t, func(s sent) bool { _, ok := s.payload.(protocol.HelperStatsPayload); return ok }).payload.(protocol.HelperStatsPayload)
	if stats.DeviceID != "d_pc" || stats.StreamID != "st_1" {
		t.Fatalf("stats = %+v", stats)
	}

	// A second start while live: busy.
	c.handle(ctx, hub, cmd("h_2", start))
	if e := hub.reply(t, "h_2").(protocol.ErrorPayload); e.Code != protocol.ErrorCodeHelperBusy || *e.DeviceID != "d_pc" {
		t.Fatalf("second start = %+v", e)
	}

	c.handle(ctx, hub, cmd("h_3", &protocol.HelperPauseStreamPayload{DeviceID: "d_pc", Paused: true}))
	hub.reply(t, "h_3")
	if st := hub.status(t, protocol.HelperStatePaused); *st.Stream.PauseReason != protocol.PauseReasonPrivacyCurtain {
		t.Fatalf("paused = %+v", st)
	}
	c.handle(ctx, hub, cmd("h_4", &protocol.HelperPauseStreamPayload{DeviceID: "d_pc", Paused: false}))
	hub.reply(t, "h_4")
	if st := hub.status(t, protocol.HelperStateLive); st.Stream.PauseReason != nil {
		t.Fatalf("resumed = %+v", st)
	}

	c.handle(ctx, hub, cmd("h_5", &protocol.HelperSetPresetPayload{DeviceID: "d_pc", Preset: protocol.PresetMax}))
	hub.reply(t, "h_5")
	if st := hub.status(t, protocol.HelperStateLive); st.Stream.Preset != protocol.PresetMax {
		t.Fatalf("preset = %+v", st)
	}
	c.handle(ctx, hub, cmd("h_6", &protocol.HelperSetPresetPayload{DeviceID: "d_pc", Preset: protocol.PresetNative}))
	if e := hub.reply(t, "h_6").(protocol.ErrorPayload); e.Code != protocol.ErrorCodePresetNotAllowed {
		t.Fatalf("refused preset = %+v", e)
	}

	c.handle(ctx, hub, cmd("h_7", &protocol.HelperStopStreamPayload{DeviceID: "d_pc"}))
	hub.status(t, protocol.HelperStateStopping)
	hub.reply(t, "h_7")
	if st := hub.status(t, protocol.HelperStateIdle); st.Stream != nil {
		t.Fatalf("idle = %+v", st)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stopped || len(s.paused) != 2 || s.presets[0] != protocol.PresetMax {
		t.Fatalf("session = %+v", s)
	}
}

func TestControllerReportsStartErrorsWithTheirCode(t *testing.T) {
	c, hub := newTestController(func(context.Context, protocol.HelperStartStreamPayload, media.Source) (session, error) {
		// What publish answers a guest without the stream permission.
		return nil, explain(&api.Error{Status: 403, Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeStreamPermissionRequired, RoomID: ptr("r_1")}})
	})
	ctx := context.Background()
	c.attach(ctx, hub)
	c.handle(ctx, hub, cmd("h_1", &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame}))
	if e := hub.reply(t, "h_1").(protocol.ErrorPayload); e.Code != protocol.ErrorCodeStreamPermissionRequired || *e.RoomID != "r_1" {
		t.Fatalf("error = %+v", e)
	}
	hub.status(t, protocol.HelperStateStarting)
	hub.status(t, protocol.HelperStateIdle)

	c.handle(ctx, hub, cmd("h_2", &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "gone", Preset: protocol.PresetGame}))
	if e := hub.reply(t, "h_2").(protocol.ErrorPayload); e.Code != protocol.ErrorCodeSourceNotFound || *e.SourceID != "gone" {
		t.Fatalf("error = %+v", e)
	}
	c.handle(ctx, hub, cmd("h_3", &protocol.HelperPauseStreamPayload{DeviceID: "d_pc", Paused: true}))
	if e := hub.reply(t, "h_3").(protocol.ErrorPayload); e.Code != protocol.ErrorCodeStreamNotFound {
		t.Fatalf("pause while idle = %+v", e)
	}
}

func TestControllerReportsAStreamThatDies(t *testing.T) {
	s := &fakeSession{done: make(chan struct{}), err: errors.New("pipeline failed")}
	c, hub := newTestController(func(context.Context, protocol.HelperStartStreamPayload, media.Source) (session, error) {
		return s, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.attach(ctx, hub)
	c.handle(ctx, hub, cmd("h_1", &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame}))
	hub.status(t, protocol.HelperStateLive)
	close(s.done)
	if st := hub.status(t, protocol.HelperStateError); st.Stream != nil {
		t.Fatalf("error = %+v", st)
	}
	// error is not busy: the web can start again.
	c.handle(ctx, hub, cmd("h_2", &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame}))
	hub.status(t, protocol.HelperStateStarting)
}

func TestControllerStopWhileStartingAborts(t *testing.T) {
	c, hub := newTestController(func(ctx context.Context, _ protocol.HelperStartStreamPayload, _ media.Source) (session, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	ctx := context.Background()
	c.attach(ctx, hub)
	c.handle(ctx, hub, cmd("h_1", &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame}))
	hub.status(t, protocol.HelperStateStarting)
	c.handle(ctx, hub, cmd("h_2", &protocol.HelperStopStreamPayload{DeviceID: "d_pc"}))
	hub.reply(t, "h_2")
	if e := hub.reply(t, "h_1").(protocol.ErrorPayload); e.Code != protocol.ErrorCodeInternalError {
		t.Fatalf("aborted start = %+v", e)
	}
	hub.status(t, protocol.HelperStateIdle)
}

func TestDescriptorMarksRestoredSources(t *testing.T) {
	picker := descriptor(media.Source{ID: media.PortalWindowID, Kind: media.SourceWindow, Label: "A window", HasAudio: true})
	if picker.Restored != nil {
		t.Errorf("picker = %+v", picker)
	}
	last := descriptor(media.Source{ID: media.PortalLastWindowID, Kind: media.SourceWindow, Label: "Docs", AppName: "firefox",
		Width: 1913, Height: 1047, HasAudio: true, Restored: true})
	if last.Restored == nil || !*last.Restored || last.SourceID != "portal:window:last" || *last.AppName != "firefox" {
		t.Errorf("last = %+v", last)
	}
}
