// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/hotkeys"
	"github.com/henriquefps/openlive/helper/internal/media"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The web controls the helper through the user hub (PROTOCOL.md §8): the
// controller executes the commands one hub socket delivers and reports the helper's state
// to the user's web tabs. A helper streams one source at a time.

// hubSender is the part of api.HubConn the controller uses.
type hubSender interface {
	Reply(ctx context.Context, id string, p protocol.Payload) error
	Send(ctx context.Context, p protocol.Payload) error
}

// session is a live stream in a room (liveSession; a fake in tests).
type session interface {
	StreamID() string
	// SetPaused pauses or resumes; reason says why (the privacy curtain, or a plain pause).
	SetPaused(ctx context.Context, paused bool, reason protocol.PauseReason) error
	SetPreset(ctx context.Context, preset protocol.Preset) error
	// Stats is the helper.stats payload since the previous call, without deviceId.
	Stats() protocol.HelperStatsPayload
	// Done is closed when the stream ends by itself; Err then says why (nil: the room
	// ended it normally).
	Done() <-chan struct{}
	Err() error
	Stop(ctx context.Context) error
}

// audioReporter is a session that knows whose audio it captures (helper.status).
type audioReporter interface {
	AudioApp() *protocol.HelperAudioApp
}

// startFunc publishes src and announces it in the room. Errors that carry a protocol
// code (REST or room socket) are passed to the web as is.
type startFunc func(ctx context.Context, req protocol.HelperStartStreamPayload, src media.Source) (session, error)

// Thumbnails fit in this box; JPEG keeps them far below the 256 KiB the protocol allows.
const (
	thumbWidth  = 320
	thumbHeight = 180
)

type controller struct {
	deviceID   string
	backend    media.MediaBackend
	start      startFunc
	log        *slog.Logger
	statsEvery time.Duration
	// observe sees every report the controller sends (helper.status, helper.stats), for
	// the tray and the notifications; it must not block.
	observe func(protocol.Payload)

	mu sync.Mutex
	// hub is the current hub socket; nil while reconnecting (the stream goes on).
	hub    hubSender
	state  protocol.HelperState
	stream *protocol.HelperStreamStatus
	live   session
	// cancelStart aborts a start in progress (stopStream while starting).
	cancelStart context.CancelFunc
	// stopping: the stream is being stopped on purpose, so its end is not an error.
	stopping bool
	// voiceSink is the voice sink while it exists; voiceOutput points it at
	// the speakers the web names (nil: no voice sink on this system).
	voiceSink   *protocol.VoiceSink
	voiceOutput func(label string)
}

func newController(deviceID string, backend media.MediaBackend, start startFunc, log *slog.Logger) *controller {
	return &controller{deviceID: deviceID, backend: backend, start: start, log: log, statsEvery: time.Second, state: protocol.HelperStateIdle}
}

// attach uses a new hub socket and tells the web the current state (PROTOCOL.md §8.1).
func (c *controller) attach(ctx context.Context, hub hubSender) {
	c.mu.Lock()
	c.hub = hub
	status := c.statusLocked()
	c.mu.Unlock()
	c.send(ctx, hub, status)
}

// detach forgets a hub socket that closed.
func (c *controller) detach(hub hubSender) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hub == hub {
		c.hub = nil
	}
}

// handle executes one command; long ones (startStream) run in the background.
func (c *controller) handle(ctx context.Context, hub hubSender, cmd api.Command) {
	switch p := cmd.Payload.(type) {
	case *protocol.HelperListSourcesPayload:
		go c.listSources(ctx, hub, cmd.ID, p.Thumbnails)
	case *protocol.HelperStartStreamPayload:
		c.startStream(ctx, hub, cmd.ID, *p)
	case *protocol.HelperStopStreamPayload:
		go c.stopStream(ctx, hub, cmd.ID)
	case *protocol.HelperPauseStreamPayload:
		// The web's pause is the privacy curtain (PROTOCOL.md §8).
		go c.withLive(ctx, hub, cmd.ID, func(s session) error {
			return c.setPaused(ctx, s, p.Paused, protocol.PauseReasonPrivacyCurtain)
		})
	case *protocol.HelperSetPresetPayload:
		go c.withLive(ctx, hub, cmd.ID, func(s session) error { return c.setPreset(ctx, s, p.Preset) })
	case *protocol.HelperSetVoiceOutputPayload:
		c.setVoiceOutput(p.Label)
		c.reply(ctx, hub, cmd.ID, protocol.AckPayload{})
	case *protocol.ErrorPayload:
		// Unsolicited errors precede a close (session_expired before 4001).
		c.log.Warn("hub error", "code", p.Code)
	default:
		if cmd.ID != "" {
			c.reply(ctx, hub, cmd.ID, protocol.ErrorPayload{Code: protocol.ErrorCodeUnknownMessageType, MessageType: ptr(protocol.MessageTypeName(cmd.Payload.Type()))})
		}
	}
}

func (c *controller) listSources(ctx context.Context, hub hubSender, id string, thumbnails bool) {
	sources, err := c.backend.ListSources(ctx)
	if err != nil {
		c.log.Warn("list sources", "err", err)
		c.reply(ctx, hub, id, protocol.ErrorPayload{Code: protocol.ErrorCodeInternalError})
		return
	}
	out := make([]protocol.SourceDescriptor, 0, len(sources))
	for _, s := range sources {
		out = append(out, descriptor(s))
	}
	c.reply(ctx, hub, id, protocol.HelperSourcesPayload{DeviceID: c.deviceID, Sources: out})
	if !thumbnails {
		return
	}
	for _, s := range sources {
		thumb, ok := c.thumbnail(ctx, s)
		if !ok {
			continue
		}
		c.send(ctx, hub, protocol.HelperSourceThumbnailPayload{
			DeviceID: c.deviceID, SourceID: s.ID, MIMEType: thumb.MimeType,
			Width: thumb.Width, Height: thumb.Height, Data: base64.StdEncoding.EncodeToString(thumb.Data),
		})
	}
}

// thumbnail grabs a still from the backend, or draws the test pattern for the test source.
func (c *controller) thumbnail(ctx context.Context, s media.Source) (media.Thumbnail, bool) {
	if t, ok := c.backend.(media.Thumbnailer); ok {
		thumb, err := t.Thumbnail(ctx, s, thumbWidth, thumbHeight)
		if err != nil {
			c.log.Debug("thumbnail", "source", s.ID, "err", err)
			return media.Thumbnail{}, false
		}
		return thumb, true
	}
	if s.Kind != media.SourceTest {
		return media.Thumbnail{}, false
	}
	thumb, err := testPatternThumbnail(thumbWidth, thumbHeight)
	return thumb, err == nil
}

func (c *controller) startStream(ctx context.Context, hub hubSender, id string, req protocol.HelperStartStreamPayload) {
	c.mu.Lock()
	if c.state != protocol.HelperStateIdle && c.state != protocol.HelperStateError {
		c.mu.Unlock()
		c.reply(ctx, hub, id, protocol.ErrorPayload{Code: protocol.ErrorCodeHelperBusy, DeviceID: &c.deviceID})
		return
	}
	startCtx, cancel := context.WithCancel(ctx)
	c.cancelStart = cancel
	c.stopping = false
	c.state = protocol.HelperStateStarting
	c.stream = &protocol.HelperStreamStatus{RoomID: req.RoomID, SourceID: req.SourceID, Preset: req.Preset}
	status := c.statusLocked()
	c.mu.Unlock()
	c.broadcast(ctx, status)

	go func() {
		defer cancel()
		s, err := c.open(startCtx, req)
		if err == nil && startCtx.Err() != nil {
			// Stopped from the web just as the start succeeded.
			stopCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
			_ = s.Stop(stopCtx)
			stop()
			err = startCtx.Err()
		}
		c.mu.Lock()
		c.cancelStart = nil
		if err != nil {
			c.state, c.stream = protocol.HelperStateIdle, nil
			status := c.statusLocked()
			c.mu.Unlock()
			c.log.Warn("start stream", "room", req.RoomID, "err", explain(err))
			c.reply(ctx, hub, id, errorPayload(err))
			c.broadcast(ctx, status)
			return
		}
		c.live = s
		c.state = protocol.HelperStateLive
		streamID := s.StreamID()
		c.stream.StreamID = &streamID
		if a, ok := s.(audioReporter); ok {
			c.stream.AudioApp = a.AudioApp()
		}
		status := c.statusLocked()
		c.mu.Unlock()
		c.log.Info("live in the room", "room", req.RoomID, "stream", streamID, "preset", req.Preset)
		c.reply(ctx, hub, id, protocol.AckPayload{})
		c.broadcast(ctx, status)
		c.watch(ctx, s)
	}()
}

// open finds the source and starts the session.
func (c *controller) open(ctx context.Context, req protocol.HelperStartStreamPayload) (session, error) {
	sources, err := c.backend.ListSources(ctx)
	if err != nil {
		return nil, err
	}
	for _, s := range sources {
		if s.ID == req.SourceID {
			return c.start(ctx, req, s)
		}
	}
	return nil, &api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeSourceNotFound, SourceID: &req.SourceID}}
}

// watch reports stats while s is live and its end when it stops by itself.
func (c *controller) watch(ctx context.Context, s session) {
	tick := time.NewTicker(c.statsEvery)
	defer tick.Stop()
	// The first interval holds the frames queued while the publication connected; skip it.
	warm := false
	for {
		select {
		case <-tick.C:
			c.mu.Lock()
			current := c.live == s && c.state == protocol.HelperStateLive
			c.mu.Unlock()
			if current && !warm {
				s.Stats()
				warm = true
			} else if current {
				stats := s.Stats()
				stats.DeviceID = c.deviceID
				c.broadcast(ctx, stats)
			}
		case <-s.Done():
			c.mu.Lock()
			if c.live != s || c.stopping {
				c.mu.Unlock()
				return
			}
			err := s.Err()
			c.live, c.stream = nil, nil
			c.state = protocol.HelperStateIdle
			if err != nil {
				c.state = protocol.HelperStateError
			}
			status := c.statusLocked()
			c.mu.Unlock()
			if err != nil {
				c.log.Warn("the stream ended", "err", explain(err))
			} else {
				c.log.Info("the room ended the stream")
			}
			stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = s.Stop(stopCtx)
			cancel()
			c.broadcast(ctx, status)
			return
		case <-ctx.Done():
			return
		}
	}
}

func (c *controller) stopStream(ctx context.Context, hub hubSender, id string) {
	c.mu.Lock()
	if c.cancelStart != nil {
		// Starting: abort; the start goroutine reports idle.
		c.cancelStart()
		c.mu.Unlock()
		c.reply(ctx, hub, id, protocol.AckPayload{})
		return
	}
	s := c.live
	if s == nil {
		c.mu.Unlock()
		c.reply(ctx, hub, id, protocol.AckPayload{})
		return
	}
	c.stopping = true
	c.state = protocol.HelperStateStopping
	status := c.statusLocked()
	c.mu.Unlock()
	c.broadcast(ctx, status)

	stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err := s.Stop(stopCtx)
	cancel()
	if err != nil {
		c.log.Warn("stop stream", "err", explain(err))
	}
	c.mu.Lock()
	c.live, c.stream = nil, nil
	c.state = protocol.HelperStateIdle
	status = c.statusLocked()
	c.mu.Unlock()
	c.log.Info("stream stopped")
	c.reply(ctx, hub, id, protocol.AckPayload{})
	c.broadcast(ctx, status)
}

// shutdown stops the stream when the helper exits.
func (c *controller) shutdown() {
	c.mu.Lock()
	if c.cancelStart != nil {
		c.cancelStart()
	}
	s := c.live
	c.stopping = true
	c.mu.Unlock()
	if s != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.Stop(ctx); err != nil {
			c.log.Warn("stop stream", "err", explain(err))
		}
	}
}

// localHub stands for the web when the tray or a shortcut runs a command: there is no
// one to reply to, so errors are logged, and the web still sees the new helper.status.
type localHub struct{ log *slog.Logger }

func (h localHub) Send(context.Context, protocol.Payload) error { return nil }
func (h localHub) Reply(_ context.Context, _ string, p protocol.Payload) error {
	if e, ok := p.(protocol.ErrorPayload); ok {
		h.log.Warn("tray command failed", "code", e.Code)
	}
	return nil
}

// pause, curtain and stop run the web's commands for the tray and the shortcuts, through
// the same code paths.
func (c *controller) pause(ctx context.Context, paused bool, reason protocol.PauseReason) {
	c.withLive(ctx, localHub{c.log}, "", func(s session) error { return c.setPaused(ctx, s, paused, reason) })
}

func (c *controller) stop(ctx context.Context) { c.stopStream(ctx, localHub{c.log}, "") }

// withLive runs fn on the live stream and replies ack, or stream_not_found when idle.
func (c *controller) withLive(ctx context.Context, hub hubSender, id string, fn func(session) error) {
	c.mu.Lock()
	s := c.live
	c.mu.Unlock()
	if s == nil {
		c.reply(ctx, hub, id, protocol.ErrorPayload{Code: protocol.ErrorCodeStreamNotFound})
		return
	}
	if err := fn(s); err != nil {
		c.log.Warn("stream command", "err", explain(err))
		c.reply(ctx, hub, id, errorPayload(err))
		return
	}
	c.reply(ctx, hub, id, protocol.AckPayload{})
}

func (c *controller) setPaused(ctx context.Context, s session, paused bool, reason protocol.PauseReason) error {
	if err := s.SetPaused(ctx, paused, reason); err != nil {
		return err
	}
	c.mu.Lock()
	if c.live != s {
		c.mu.Unlock()
		return nil
	}
	if paused {
		c.state = protocol.HelperStatePaused
		c.stream.PauseReason = ptr(reason)
	} else {
		c.state = protocol.HelperStateLive
		c.stream.PauseReason = nil
	}
	status := c.statusLocked()
	c.mu.Unlock()
	c.broadcast(ctx, status)
	return nil
}

func (c *controller) setPreset(ctx context.Context, s session, preset protocol.Preset) error {
	if err := s.SetPreset(ctx, preset); err != nil {
		return err
	}
	c.mu.Lock()
	if c.live != s {
		c.mu.Unlock()
		return nil
	}
	c.stream.Preset = preset
	status := c.statusLocked()
	c.mu.Unlock()
	c.broadcast(ctx, status)
	return nil
}

// setVoiceOutput passes the web's speakers to the voice sink; with none (another OS,
// no PipeWire) there is nothing to route and the command is still acknowledged.
func (c *controller) setVoiceOutput(label *string) {
	c.mu.Lock()
	set := c.voiceOutput
	c.mu.Unlock()
	if set == nil {
		return
	}
	if label == nil {
		set("")
	} else {
		set(*label)
	}
}

// setVoiceSink reports the voice sink appearing (vs) or going away (nil).
func (c *controller) setVoiceSink(ctx context.Context, vs *protocol.VoiceSink) {
	c.mu.Lock()
	c.voiceSink = vs
	status := c.statusLocked()
	c.mu.Unlock()
	c.broadcast(ctx, status)
}

func (c *controller) statusLocked() protocol.HelperStatusPayload {
	status := protocol.HelperStatusPayload{DeviceID: c.deviceID, State: c.state}
	if c.voiceSink != nil {
		vs := *c.voiceSink
		status.VoiceSink = &vs
	}
	if c.stream != nil {
		s := *c.stream
		status.Stream = &s
	}
	return status
}

// broadcast sends a report on the current hub socket, if any.
func (c *controller) broadcast(ctx context.Context, p protocol.Payload) {
	c.mu.Lock()
	hub := c.hub
	c.mu.Unlock()
	if c.observe != nil {
		c.observe(p)
	}
	if hub != nil {
		c.send(ctx, hub, p)
	}
}

// voiceShortcut tells the user's web tabs that a global voice shortcut went down or up
// (helper.voiceShortcut, PROTOCOL.md §8.5). It is not a report of the stream, so it skips
// observe; with no hub socket it is dropped.
func (c *controller) voiceShortcut(ctx context.Context, a hotkeys.Action, pressed bool) {
	var action protocol.VoiceShortcutAction
	switch a {
	case hotkeys.Talk:
		action = protocol.VoiceShortcutActionPushToTalk
	case hotkeys.Mute:
		action = protocol.VoiceShortcutActionToggleMute
	case hotkeys.Deafen:
		action = protocol.VoiceShortcutActionToggleDeafen
	default:
		return
	}
	c.mu.Lock()
	hub := c.hub
	c.mu.Unlock()
	if hub == nil {
		return
	}
	c.send(ctx, hub, protocol.HelperVoiceShortcutPayload{DeviceID: c.deviceID, Action: action, Pressed: pressed})
}

func (c *controller) send(ctx context.Context, hub hubSender, p protocol.Payload) {
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := hub.Send(wctx, p); err != nil {
		c.log.Debug("hub send", "type", p.Type(), "err", err)
	}
}

func (c *controller) reply(ctx context.Context, hub hubSender, id string, p protocol.Payload) {
	if id == "" {
		// No id: no reply on success, errors still go out (PROTOCOL.md §3).
		if _, isErr := p.(protocol.ErrorPayload); !isErr {
			return
		}
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := hub.Reply(wctx, id, p); err != nil {
		c.log.Debug("hub reply", "type", p.Type(), "err", err)
	}
}

// descriptor is a source as helper.sources lists it. The schema has no "test" kind; the
// test pattern stands in for a screen.
func descriptor(s media.Source) protocol.SourceDescriptor {
	kind := protocol.SourceKindScreen
	if s.Kind == media.SourceWindow {
		kind = protocol.SourceKindWindow
	}
	// The test pattern has its test tone.
	hasAudio := s.HasAudio || s.Kind == media.SourceTest
	d := protocol.SourceDescriptor{SourceID: s.ID, Kind: kind, Label: s.Label, HasAudio: hasAudio}
	if s.AppName != "" {
		d.AppName = &s.AppName
	}
	if s.Width > 0 && s.Height > 0 {
		d.Width, d.Height = &s.Width, &s.Height
	}
	if s.Restored {
		d.Restored = ptr(true)
	}
	return d
}

// errorPayload is the protocol error for a failed command: the code the instance sent
// (REST or room socket), else internal_error.
func errorPayload(err error) protocol.ErrorPayload {
	var apiErr *api.Error
	var replyErr *api.ReplyError
	switch {
	case errors.As(err, &replyErr):
		return replyErr.Payload
	case errors.As(err, &apiErr) && apiErr.Payload.Code != "":
		return apiErr.Payload
	}
	return protocol.ErrorPayload{Code: protocol.ErrorCodeInternalError}
}

func ptr[T any](v T) *T { return &v }
