// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png" // --test-image
	"log/slog"
	"os"
	"slices"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/audio"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/overlay"
	"github.com/henriquefps/openlive/helper/internal/portal"
	"github.com/henriquefps/openlive/helper/internal/rtc"
	"github.com/henriquefps/openlive/helper/internal/thumbnail"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
	xdraw "golang.org/x/image/draw"
)

// liveConfig is what every stream started from the web shares (the run command's flags).
type liveConfig struct {
	client   *api.Client
	deviceID string
	backend  media.MediaBackend
	rids     []string
	encoder  media.Encoder
	// av1 says whether streams also publish the AV1 track.
	av1 media.AV1Mode
	gop time.Duration
	// vbv is the encoders' buffer as time at the start bitrate (0: media.DefaultVBV).
	vbv time.Duration
	log *slog.Logger
	// onViewers hears the viewer count of the live stream (the tray, the notifications).
	onViewers func(used int)
}

// liveSession is a stream started from the web: the same publish path as test-stream
// (room settings → capture → publish → stream.announce), plus the privacy curtain and
// preset changes while live.
type liveSession struct {
	cfg      liveConfig
	src      media.Source
	audio    bool
	settings protocol.RoomSettings
	stream   *gatedStream
	pub      *rtc.Publisher
	room     *liveRoom
	stats    *statsSampler
	// label is what the stream card shows as the source.
	label string
	// audioApp is whose audio the stream captures (helper.status), nil without app audio.
	audioApp *protocol.HelperAudioApp
	// thumbs sends the card's snapshot every 10 s.
	thumbs *thumbnail.Runner

	mu     sync.Mutex
	preset media.Preset
	enc    media.Encoder
	// chosen is the streamer's preset; preset is lower while economy mode caps it.
	chosen media.Preset
	// qualityCap is economy mode's cap, nil while off.
	qualityCap *protocol.QualityCap
	// curtain and hidden pause the thumbnails (the streamer's curtain, a hidden source).
	curtain, hidden bool
	// switching serializes preset switches: the web's and economy mode's.
	switching sync.Mutex

	done     chan struct{}
	err      error
	stopOnce sync.Once
	ctx      context.Context
	cancel   context.CancelFunc
}

func presetOf(p protocol.Preset) (media.Preset, error) {
	for _, preset := range media.Presets {
		if preset.Protocol == p {
			return preset, nil
		}
	}
	return media.Preset{}, fmt.Errorf("unknown preset %q", p)
}

// startLive publishes src in the room and announces it. The context only bounds the start.
func startLive(ctx context.Context, cfg liveConfig, req protocol.HelperStartStreamPayload, src media.Source) (*liveSession, error) {
	preset, err := presetOf(req.Preset)
	if err != nil {
		return nil, err
	}
	layers, err := preset.Layers(cfg.rids)
	if err != nil {
		return nil, err
	}
	layers = media.WithVBV(layers, cfg.vbv)
	// Publish before opening the room socket (see test-stream): a hello from this device
	// would replace the socket of another helper process still streaming here.
	settings, err := cfg.client.RoomSettings(ctx, req.RoomID)
	if err != nil {
		return nil, err
	}
	if layers, err = withAV1(cfg.av1, &settings, preset, cfg.encoder, layers, media.HasElement, cfg.log); err != nil {
		return nil, err
	}
	rcfg := rtc.Config{Layers: layers, Audio: req.Audio, Logger: cfg.log, EstimateMaxKbps: estimateMaxKbps(settings, cfg.rids) * withAV1Share(layers) / 100}
	maxKbps, err := fitRoom(settings, preset, layers, req.Audio, &rcfg)
	if err != nil {
		return nil, err
	}
	inner, enc, err := startCapture(ctx, cfg, src, layers, req.Audio)
	if err != nil {
		return nil, err
	}
	// The Linux backend fits the layers to the source's aspect ratio.
	if l, ok := inner.(interface{ Layers() []media.Layer }); ok {
		layers = l.Layers()
	}
	rcfg.Layers = layers
	s := &liveSession{cfg: cfg, src: src, audio: req.Audio, settings: settings, preset: preset, enc: enc, done: make(chan struct{})}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.stream = newGatedStream(inner, layers, req.Audio)
	fail := func(err error) (*liveSession, error) {
		s.cancel()
		_ = s.stream.Stop()
		return nil, err
	}

	sig := &api.Signaler{Client: cfg.client, RoomID: req.RoomID, Preset: preset.Protocol, MaxBitrateKbps: maxKbps}
	rcfg.ICEServers = iceServers(ctx, cfg.client, req.RoomID, cfg.log)
	if s.pub, err = rtc.Publish(ctx, rcfg, s.stream, sig); err != nil {
		return fail(err)
	}
	s.room = &liveRoom{client: cfg.client, roomID: req.RoomID, opts: api.RoomOptions{DeviceID: cfg.deviceID, ClientVersion: version}, log: cfg.log, onViewers: cfg.onViewers}
	if s.room.conn, err = api.DialRoom(ctx, cfg.client, req.RoomID, s.room.opts); err != nil {
		s.closePub()
		return fail(fmt.Errorf("room socket: %w", err))
	}
	s.room.pings = newPings(cfg.log, s.stream.pingTarget)
	info := sourceInfo(src, inner)
	s.label = info.Label
	s.audioApp = audioAppOf(inner)
	if err := s.room.announce(ctx, preset, s.pub, req.Audio, info, encodedLayers(layers, maxKbps, req.Audio)); err != nil {
		s.room.close()
		s.closePub()
		return fail(err)
	}
	s.stats = newStatsSampler(s.pub)
	s.chosen = preset
	s.thumbs = thumbnail.Start(s.stream, s.uploadThumbnail, layers[0].Width, layers[0].Height, cfg.log)
	go s.run()
	// Economy mode: fit under the cap the publish answered with.
	if sig.QualityCap != nil {
		go s.applyCap(sig.QualityCap)
	}
	return s, nil
}

// uploadThumbnail sends one thumbnail of this stream (PROTOCOL.md §11.3).
func (s *liveSession) uploadThumbnail(ctx context.Context, jpeg []byte, placeholder bool) error {
	return s.cfg.client.PutThumbnail(ctx, s.room.roomID, s.room.streamID, jpeg, placeholder)
}

// pauseThumbnails follows the curtain and the source's visibility: while either is down,
// the card gets the paused placeholder and nothing of the screen.
func (s *liveSession) pauseThumbnails(curtain, hidden *bool) {
	s.mu.Lock()
	if curtain != nil {
		s.curtain = *curtain
	}
	if hidden != nil {
		s.hidden = *hidden
	}
	paused := s.curtain || s.hidden
	s.mu.Unlock()
	s.thumbs.SetPaused(paused)
}

// estimateMaxKbps lets the bandwidth estimate probe for the largest preset the room allows
// (1.5× its layers' sum), so a later preset change is not capped by the first one's.
func estimateMaxKbps(settings protocol.RoomSettings, rids []string) int {
	top := 0
	for _, p := range media.Presets {
		if !slices.Contains(settings.AllowedPresets, p.Protocol) {
			continue
		}
		if layers, err := p.Layers(rids); err == nil {
			sum, _ := rtc.SumTargets(layers)
			top = max(top, sum)
		}
	}
	if settings.MaxBitrateKbps > 0 {
		top = min(top, settings.MaxBitrateKbps)
	}
	return top * 3 / 2
}

// startCapture starts the backend on src and returns the encoder in use.
func startCapture(ctx context.Context, cfg liveConfig, src media.Source, layers []media.Layer, audio bool) (media.Stream, media.Encoder, error) {
	stream, err := cfg.backend.Start(ctx, src, media.Profile{Layers: layers, Encoder: cfg.encoder, Audio: audio, GOP: cfg.gop})
	if err != nil {
		return nil, "", fmt.Errorf("capture: %w", err)
	}
	enc := cfg.encoder
	if e, ok := stream.(interface{ Encoder() media.Encoder }); ok {
		enc = e.Encoder()
	}
	return stream, enc, nil
}

// sourceInfo is what the stream card shows: what the portal shared when the backend
// knows it (the window's title, the monitor's name), else the listed source.
func sourceInfo(src media.Source, stream media.Stream) protocol.SourceInfo {
	kind, label := src.Kind, src.Label
	if s, ok := stream.(interface{ SharedSource() portal.Source }); ok {
		shared := s.SharedSource()
		kind = media.SourceScreen
		if shared.Kind == portal.KindWindow {
			kind = media.SourceWindow
		}
		if shared.Label != "" {
			label = shared.Label
		}
	}
	info := protocol.SourceInfo{Kind: protocol.SourceKindScreen, Label: label}
	if kind == media.SourceWindow {
		info.Kind = protocol.SourceKindWindow
	}
	return info
}

// audioAppOf is whose audio a stream captures, as helper.status reports it, with the
// browser family the web compares with its own.
func audioAppOf(stream media.Stream) *protocol.HelperAudioApp {
	s, ok := stream.(interface{ AudioApp() (media.AudioApp, bool) })
	if !ok {
		return nil
	}
	app, ok := s.AudioApp()
	if !ok || app.Name == "" {
		return nil
	}
	out := &protocol.HelperAudioApp{Name: truncate(app.Name, 200)}
	if app.Binary != "" {
		out.Binary = ptr(truncate(app.Binary, 200))
	}
	if app.PID > 0 {
		out.Pid = ptr(app.PID)
	}
	if f := audio.BrowserFamily(app.Binary, app.Name); f != "" {
		out.Browser = ptr(protocol.BrowserFamily(f))
	}
	return out
}

// truncate cuts s to at most n bytes on a rune boundary.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// run follows the stream until it ends: room events, room socket reconnects, capture and
// publication failures.
func (s *liveSession) run() {
	defer close(s.done)
	for {
		select {
		case <-s.ctx.Done():
			return
		case err := <-s.stream.Err():
			if errors.Is(err, media.ErrSourceEnded) {
				// The window closed or sharing stopped from the desktop: a normal end.
				s.cfg.log.Info("the shared source ended")
				return
			}
			s.err = err
			return
		case ev := <-s.stream.Events():
			if ev.Resized {
				s.cfg.log.Info("the source was resized; scaled into the same output size", "size", fmt.Sprintf("%dx%d", ev.Width, ev.Height))
				continue
			}
			// A hidden or minimized source pauses the stream.
			s.pauseThumbnails(nil, &ev.Paused)
			s.room.update(s.ctx, ev.Paused, ev.PauseReason)
		case <-s.pub.Done():
			s.err = s.pub.Err()
			if s.err == nil {
				s.err = errors.New("the publication closed")
			}
			return
		case ev, ok := <-s.room.conn.Events():
			if !ok {
				continue // Done is closed too
			}
			// Economy mode turned on or off for this stream: switch off the run loop, which
			// must keep reading the room's replies meanwhile.
			if u, ok := ev.(*protocol.StreamUpdatedPayload); ok && u.Stream.StreamID == s.room.streamID {
				go s.applyCap(u.Stream.QualityCap)
			}
			if done, err := s.room.handle(ev); done {
				s.err = err
				return
			}
		case <-s.room.conn.Done():
			if err := s.room.resume(s.ctx); err != nil {
				s.err = err
				return
			}
		}
	}
}

func (s *liveSession) StreamID() string    { return s.room.streamID }
func (s *liveSession) RoomName() string    { return s.room.conn.Welcome().Room.Name }
func (s *liveSession) SourceLabel() string { return s.label }

// AudioApp is whose audio the stream captures, nil without app audio.
func (s *liveSession) AudioApp() *protocol.HelperAudioApp { return s.audioApp }
func (s *liveSession) Done() <-chan struct{}              { return s.done }
func (s *liveSession) Err() error                         { return s.err }

// SetPaused is the privacy curtain or a plain pause: no frames leave the helper while it
// is down, and the room shows the stream as paused.
func (s *liveSession) SetPaused(ctx context.Context, paused bool, reason protocol.PauseReason) error {
	update := protocol.StreamUpdatePayload{StreamID: s.room.streamID, Paused: &paused}
	if paused {
		// Thumbnails stop first: nothing of the screen after the curtain is asked for.
		s.pauseThumbnails(&paused, nil)
		update.PauseReason = ptr(reason)
		s.stream.SetPaused(true)
	}
	if err := s.room.conn.Update(ctx, update); err != nil {
		if paused {
			s.stream.SetPaused(false)
			off := false
			s.pauseThumbnails(&off, nil)
		}
		return err
	}
	if !paused {
		s.stream.SetPaused(false)
		s.pauseThumbnails(&paused, nil)
	}
	return nil
}

// SetPreset restarts the capture with the new preset's layers and swaps it in under the
// same publication, so viewers keep watching (the resolution changes in-band). While
// economy mode caps the stream, the preset is remembered and the capped one is used.
func (s *liveSession) SetPreset(ctx context.Context, p protocol.Preset) error {
	preset, err := presetOf(p)
	if err != nil {
		return err
	}
	if !slices.Contains(s.settings.AllowedPresets, p) {
		return &api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodePresetNotAllowed, Preset: &p}}
	}
	s.switching.Lock()
	defer s.switching.Unlock()
	s.mu.Lock()
	s.chosen = preset
	qc := s.qualityCap
	s.mu.Unlock()
	return s.switchTo(ctx, capPreset(s.settings.AllowedPresets, preset, qc), qc)
}

// applyCap follows economy mode: under a cap the stream runs the
// highest allowed preset that fits it, at most the cap's bitrate; without one it goes
// back to the streamer's preset. The room repeats the cap in every stream.updated, so an
// unchanged cap does nothing.
func (s *liveSession) applyCap(qc *protocol.QualityCap) {
	s.switching.Lock()
	defer s.switching.Unlock()
	s.mu.Lock()
	same := sameCap(s.qualityCap, qc)
	s.qualityCap = qc
	chosen := s.chosen
	s.mu.Unlock()
	if same {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	target := capPreset(s.settings.AllowedPresets, chosen, qc)
	if err := s.switchTo(ctx, target, qc); err != nil {
		s.cfg.log.Warn("economy mode: could not apply the cap", "err", explain(err))
		return
	}
	if qc != nil {
		s.cfg.log.Info("economy mode: stream capped", "preset", target.Name, "maxHeight", qc.MaxHeight, "maxKbps", qc.MaxBitrateKbps)
	} else {
		s.cfg.log.Info("economy mode off: back to the chosen preset", "preset", target.Name)
	}
}

// switchTo runs preset under the cap qc: a new capture when the preset changes, else only
// the bitrate. The caller holds s.switching.
func (s *liveSession) switchTo(ctx context.Context, preset media.Preset, qc *protocol.QualityCap) error {
	s.mu.Lock()
	same := s.preset.Protocol == preset.Protocol
	s.mu.Unlock()
	layers, err := preset.Layers(s.cfg.rids)
	if err != nil {
		return err
	}
	layers = media.WithVBV(layers, s.cfg.vbv)
	// The publication keeps its tracks: the AV1 one stays, with the new preset's layers and mode.
	if media.HasAV1(s.stream.Layers()) {
		layers = media.WithAV1(layers, media.AV1PercentFor(&s.settings, preset.Protocol))
	}
	if same {
		// Same size: keep the capture, give the encoders the (un)capped budget.
		layers = capLayers(withTargets(s.stream.Layers(), layers), qc, s.audio)
		var rcfg rtc.Config
		if _, err := fitRoom(s.settings, preset, layers, s.audio, &rcfg); err != nil {
			return err
		}
		return s.pub.SetLayers(layers, rcfg.Rate.MaxKbps)
	}
	layers = capLayers(layers, qc, s.audio)
	// The room's cap is fitted to the new layers, as at the start.
	var rcfg rtc.Config
	maxKbps, err := fitRoom(s.settings, preset, layers, s.audio, &rcfg)
	if err != nil {
		return err
	}
	inner, enc, err := startCapture(ctx, s.cfg, s.src, layers, s.audio)
	if err != nil {
		return err
	}
	if l, ok := inner.(interface{ Layers() []media.Layer }); ok {
		layers = l.Layers()
	}
	p := preset.Protocol
	update := protocol.StreamUpdatePayload{StreamID: s.room.streamID, Preset: &p, Layers: encodedLayers(layers, maxKbps, s.audio)}
	if err := s.room.conn.Update(ctx, update); err != nil {
		_ = inner.Stop()
		return err
	}
	s.stream.Swap(inner, layers)
	// The rate controller and the encoders get the new preset's budget.
	if err := s.pub.SetLayers(layers, rcfg.Rate.MaxKbps); err != nil {
		s.cfg.log.Warn("bitrate after the preset change", "err", err)
	}
	s.mu.Lock()
	s.preset, s.enc = preset, enc
	s.mu.Unlock()
	s.cfg.log.Info("preset changed", "preset", preset.Name, "encoder", enc)
	return nil
}

// capPreset is the highest allowed preset, not above chosen, whose top layer fits the
// cap's height and runs at 60 fps at most (economy mode saves egress; 120 fps doubles it);
// chosen without a cap or when none fits.
func capPreset(allowed []protocol.Preset, chosen media.Preset, qc *protocol.QualityCap) media.Preset {
	if qc == nil {
		return chosen
	}
	best := chosen
	found := false
	for _, p := range media.Presets {
		if p.Top.Height <= qc.MaxHeight && p.Top.FPS <= 60 && slices.Contains(allowed, p.Protocol) {
			best, found = p, true
		}
		if p.Protocol == chosen.Protocol {
			break
		}
	}
	if !found {
		return chosen
	}
	return best
}

// capLayers lowers every layer's target to the cap's bitrate, audio included.
func capLayers(layers []media.Layer, qc *protocol.QualityCap, audio bool) []media.Layer {
	out := slices.Clone(layers)
	if qc == nil {
		return out
	}
	budget := qc.MaxBitrateKbps
	if audio {
		budget -= audioKbps
	}
	for i := range out {
		out[i].Kbps = max(1, min(out[i].Kbps, budget))
		out[i].MinKbps = min(out[i].MinKbps, out[i].Kbps)
	}
	return out
}

// withTargets keeps the running layers' sizes and takes the preset's targets by RID.
func withTargets(running, preset []media.Layer) []media.Layer {
	out := slices.Clone(running)
	for i := range out {
		for _, p := range preset {
			if p.RID == out[i].RID {
				out[i].Kbps, out[i].MinKbps = p.Kbps, p.MinKbps
			}
		}
	}
	return out
}

func sameCap(a, b *protocol.QualityCap) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func (s *liveSession) Stats() protocol.HelperStatsPayload {
	s.mu.Lock()
	enc := s.enc
	s.mu.Unlock()
	return s.stats.sample(s.room.streamID, s.stream.Layers(), string(enc), s.stream)
}

// Stop ends the stream in the room (stream.end), unpublishes and stops the capture.
func (s *liveSession) Stop(context.Context) error {
	s.stopOnce.Do(func() {
		s.cancel()
		<-s.done
		s.thumbs.Stop()
		s.room.end()
		s.room.close()
		s.closePub()
		_ = s.stream.Stop()
	})
	return nil
}

func (s *liveSession) closePub() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.pub.Close(ctx); err != nil {
		s.cfg.log.Warn("unpublish", "err", explain(err))
	}
}

// gatedStream is a media.Stream over a capture that can be paused (frames are dropped:
// the privacy curtain) and swapped for another capture with the same layers' RIDs (a
// preset change). The publisher reads it like any stream.
type gatedStream struct {
	video  chan media.EncodedFrame
	audio  chan media.EncodedFrame
	err    chan error
	events chan media.SourceEvent

	mu     sync.Mutex
	inner  media.Stream
	layers []media.Layer
	// curtain is the streamer's choice; paused drops frames (captures without a curtain).
	curtain bool
	paused  bool
	// stop ends the forwarding of the current inner stream.
	stop chan struct{}
}

func newGatedStream(inner media.Stream, layers []media.Layer, audio bool) *gatedStream {
	g := &gatedStream{video: make(chan media.EncodedFrame, 64), err: make(chan error, 1), events: make(chan media.SourceEvent, 8)}
	if audio {
		g.audio = make(chan media.EncodedFrame, 64)
	}
	g.Swap(inner, layers)
	return g
}

func (g *gatedStream) Video() <-chan media.EncodedFrame { return g.video }

// Audio is nil without audio, as media.Stream requires.
func (g *gatedStream) Audio() <-chan media.EncodedFrame {
	if g.audio == nil {
		return nil
	}
	return g.audio
}

func (g *gatedStream) Err() <-chan error { return g.err }

// Events are the capture's pause and resize events (backends that report them).
func (g *gatedStream) Events() <-chan media.SourceEvent { return g.events }

// pingTarget is the current capture as a ping target (a preset switch replaces it).
func (g *gatedStream) pingTarget() (overlay.Target, bool) {
	t, ok := g.current().(overlay.Target)
	return t, ok
}

func (g *gatedStream) current() media.Stream {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inner
}

func (g *gatedStream) SetBitrate(rid string, kbps int) error {
	if s := g.current(); s != nil {
		return s.SetBitrate(rid, kbps)
	}
	return nil
}

// Snapshot is the capture's newest thumbnail frame (internal/thumbnail); never one while
// the curtain is down.
func (g *gatedStream) Snapshot() ([]byte, bool) {
	g.mu.Lock()
	inner, curtain := g.inner, g.curtain
	g.mu.Unlock()
	if curtain {
		return nil, false
	}
	if s, ok := inner.(thumbnail.Source); ok {
		return s.Snapshot()
	}
	return nil, false
}

func (g *gatedStream) RequestKeyframe(rid string) error {
	if s := g.current(); s != nil {
		return s.RequestKeyframe(rid)
	}
	return nil
}

// CaptureStats are the capture counters of the stream in use, when its backend has them.
// A preset change swaps the stream, so the counters can start over.
func (g *gatedStream) CaptureStats() (media.CaptureStats, bool) {
	if cs, ok := g.current().(captureStatser); ok {
		return cs.CaptureStats(), true
	}
	return media.CaptureStats{}, false
}

// Layers are the layers of the capture in use.
func (g *gatedStream) Layers() []media.Layer {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.layers
}

// SetPaused is the privacy curtain. A backend with its own curtain (the Linux one) sends
// black frames, which keeps the encoders and the SFU's tracks alive; for the others every
// frame is dropped. After the curtain lifts each layer starts again on a keyframe.
func (g *gatedStream) SetPaused(paused bool) {
	g.mu.Lock()
	inner, layers := g.inner, g.layers
	c, own := inner.(curtained)
	g.curtain = paused
	g.paused = paused && !own
	g.mu.Unlock()
	if own {
		c.SetCurtain(paused)
	}
	if !paused {
		requestKeyframes(inner, layers)
	}
}

// curtained is a capture with its own privacy curtain (controllable in stream.go).
type curtained interface{ SetCurtain(on bool) }

// Swap starts forwarding from inner and stops the previous capture.
func (g *gatedStream) Swap(inner media.Stream, layers []media.Layer) {
	stop := make(chan struct{})
	c, own := inner.(curtained)
	g.mu.Lock()
	old, oldStop := g.inner, g.stop
	g.inner, g.layers, g.stop = inner, layers, stop
	// A new capture keeps the curtain the streamer chose.
	curtain := g.curtain
	g.paused = curtain && !own
	g.mu.Unlock()
	if curtain && own {
		c.SetCurtain(true)
	}
	if oldStop != nil {
		close(oldStop)
	}
	if old != nil {
		_ = old.Stop()
	}
	go g.forward(inner.Video(), g.video, stop)
	if g.audio != nil && inner.Audio() != nil {
		go g.forward(inner.Audio(), g.audio, stop)
	}
	if ev, ok := inner.(interface {
		Events() <-chan media.SourceEvent
	}); ok {
		go func() {
			for {
				select {
				case e, ok := <-ev.Events():
					if !ok {
						return
					}
					select {
					case g.events <- e:
					default: // nobody listening: the next event carries the state anyway
					}
				case <-stop:
					return
				}
			}
		}()
	}
	go func() {
		select {
		case err, ok := <-inner.Err():
			if ok && err != nil {
				select {
				case g.err <- err:
				default:
				}
			}
		case <-stop:
		}
	}()
	requestKeyframes(inner, layers)
}

func (g *gatedStream) forward(in <-chan media.EncodedFrame, out chan<- media.EncodedFrame, stop <-chan struct{}) {
	for {
		select {
		case f, ok := <-in:
			if !ok {
				return
			}
			g.mu.Lock()
			paused := g.paused
			g.mu.Unlock()
			if paused {
				continue
			}
			select {
			case out <- f:
			case <-stop:
				return
			}
		case <-stop:
			return
		}
	}
}

// Stop stops forwarding and the capture.
func (g *gatedStream) Stop() error {
	g.mu.Lock()
	inner, stop := g.inner, g.stop
	g.inner, g.stop = nil, nil
	g.mu.Unlock()
	if stop != nil {
		close(stop)
	}
	if inner == nil {
		return nil
	}
	return inner.Stop()
}

func requestKeyframes(s media.Stream, layers []media.Layer) {
	if s == nil {
		return
	}
	for _, l := range layers {
		_ = s.RequestKeyframe(l.RID)
	}
}

// statsSampler turns the publisher's running counts into helper.stats rates.
type statsSampler struct {
	pub     *rtc.Publisher
	prev    rtc.Stats
	at      time.Time
	cpu     time.Duration
	capture uint64
}

func newStatsSampler(pub *rtc.Publisher) *statsSampler {
	cpu, _ := processCPUTime()
	return &statsSampler{pub: pub, prev: pub.Stats(), at: time.Now(), cpu: cpu}
}

// captureCounter is what the sampler reads of the capture (gatedStream); nil when there is none.
type captureCounter interface {
	CaptureStats() (media.CaptureStats, bool)
}

func (s *statsSampler) sample(streamID string, layers []media.Layer, encoder string, capture captureCounter) protocol.HelperStatsPayload {
	now := time.Now()
	secs := max(now.Sub(s.at).Seconds(), 0.001)
	cur := s.pub.Stats()
	out := protocol.HelperStatsPayload{
		StreamID:          streamID,
		TargetBitrateKbps: cur.TargetKbps,
		PacketLossPct:     min(cur.Loss*100, 100),
	}
	if encoder != "" {
		out.Encoder = &encoder
	}
	requests, idr := 0, 0
	for i, l := range cur.Layers {
		p := s.prev.Layers[i]
		fps := float64(l.Frames-p.Frames) / secs
		kbps := int(float64(l.Bytes-p.Bytes) * 8 / secs / 1000)
		ls := protocol.HelperLayerStats{Rid: l.RID, FPS: fps, TargetBitrateKbps: l.TargetKbps, SentBitrateKbps: kbps}
		for _, cfg := range layers {
			if cfg.RID == l.RID {
				ls.Width, ls.Height = cfg.Width, cfg.Height
			}
		}
		out.SentBitrateKbps += kbps
		out.Layers = append(out.Layers, ls)
		if i == 0 {
			out.FPS, out.Width, out.Height = fps, ls.Width, ls.Height
		}
		requests += max(0, l.PLIs+l.FIRs-p.PLIs-p.FIRs)
		if l.Keyframes > p.Keyframes {
			idr = max(idr, l.LastKeyframeBytes)
		}
	}
	out.KeyframeRequests = &requests
	out.IdrBytes = &idr
	if cpu, ok := processCPUTime(); ok {
		pct := max(0, (cpu-s.cpu).Seconds()/secs*100)
		out.CpuPct = &pct
		s.cpu = cpu
	}
	if capture != nil {
		if cs, ok := capture.CaptureStats(); ok {
			// A new capture (preset change) starts its counter over: skip that one report.
			if cs.Captured >= s.capture {
				fps := float64(cs.Captured-s.capture) / secs
				out.CapturedFPS = &fps
			}
			s.capture = cs.Captured
		}
	}
	s.prev, s.at = cur, now
	return out
}

// testPatternThumbnail draws SMPTE-like colour bars: the picker's preview of the test source.
func testPatternThumbnail(w, h int) (media.Thumbnail, error) {
	bars := []color.RGBA{
		{192, 192, 192, 255}, {192, 192, 0, 255}, {0, 192, 192, 255}, {0, 192, 0, 255},
		{192, 0, 192, 255}, {192, 0, 0, 255}, {0, 0, 192, 255},
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		c := bars[x*len(bars)/w]
		for y := range h {
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 70}); err != nil {
		return media.Thumbnail{}, err
	}
	return media.Thumbnail{MimeType: "image/jpeg", Width: w, Height: h, Data: buf.Bytes()}, nil
}

// imageThumbnail is the picker's preview of a --test-image: the image fitted into w x h.
func imageThumbnail(path string, w, h int) (media.Thumbnail, error) {
	f, err := os.Open(path)
	if err != nil {
		return media.Thumbnail{}, err
	}
	defer func() { _ = f.Close() }()
	src, _, err := image.Decode(f)
	if err != nil {
		return media.Thumbnail{}, fmt.Errorf("%s: %w", path, err)
	}
	b := src.Bounds()
	if b.Dx()*h > b.Dy()*w {
		h = max(2, w*b.Dy()/b.Dx())
	} else {
		w = max(2, h*b.Dx()/b.Dy())
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, xdraw.Src, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 80}); err != nil {
		return media.Thumbnail{}, err
	}
	return media.Thumbnail{MimeType: "image/jpeg", Width: w, Height: h, Data: buf.Bytes()}, nil
}
