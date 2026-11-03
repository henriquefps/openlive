// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/overlay"
	"github.com/henriquefps/openlive/helper/internal/rtc"
	"github.com/henriquefps/openlive/helper/internal/thumbnail"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

type streamFlags struct {
	common
	room       string
	preset     string
	noAudio    bool
	tone       bool
	layers     string
	encoder    string
	av1        string
	gop        time.Duration
	vbv        time.Duration
	duration   time.Duration
	statsEvery time.Duration
	loopback   bool
	pliEvery   time.Duration
}

// registerPublish adds the flags every streaming command shares.
func (f *streamFlags) registerPublish(fs *flag.FlagSet) {
	f.register(fs)
	fs.StringVar(&f.room, "room", "", "room id to stream to")
	fs.StringVar(&f.preset, "preset", media.DefaultPreset, "1080p30 (text), 1080p60 (game), 1440p60 (max), 2160p60 (native), 1080p120 (game120) or 1440p120 (max120)")
	fs.StringVar(&f.layers, "layers", "f,h,q", "simulcast layers to send: f (preset), h (720p60), q (480p30)")
	fs.StringVar(&f.encoder, "encoder", "auto", media.EncoderUsage)
	fs.StringVar(&f.av1, "av1", string(media.AV1Auto), "also publish the top layer in AV1 on a second track: "+media.AV1Usage)
	fs.DurationVar(&f.gop, "gop", 10*time.Second, "fallback keyframe interval (keyframes normally come on PLI/FIR)")
	fs.DurationVar(&f.vbv, "vbv", media.DefaultVBV, vbvUsage)
	fs.DurationVar(&f.duration, "duration", 0, "stop after this long (0: until Ctrl+C)")
	fs.DurationVar(&f.statsEvery, "stats-every", 5*time.Second, "how often to log fps and bitrate per layer")
	fs.BoolVar(&f.loopback, "loopback", false, "publish to an in-process receiver instead of an instance (no pairing needed)")
	fs.DurationVar(&f.pliEvery, "pli-every", 3*time.Second, "with --loopback: send a PLI on the top layer (of each video track) this often (0: never)")
}

// profile validates the shared flags.
func (f *streamFlags) profile() (media.Preset, []media.Layer, media.Encoder, error) {
	if !f.loopback && f.room == "" {
		return media.Preset{}, nil, "", errors.New("--room is required (or --loopback to stream to an in-process receiver)")
	}
	preset, err := media.FindPreset(f.preset)
	if err != nil {
		return media.Preset{}, nil, "", err
	}
	layers, err := preset.Layers(media.ParseLayers(f.layers))
	if err != nil {
		return media.Preset{}, nil, "", err
	}
	if err := checkVBV(f.vbv); err != nil {
		return media.Preset{}, nil, "", err
	}
	layers = media.WithVBV(layers, f.vbv)
	enc, err := media.ParseEncoder(f.encoder)
	return preset, layers, enc, err
}

// context is the command's context: Ctrl+C, SIGTERM and --duration end it.
func (f *streamFlags) context() (context.Context, context.CancelFunc) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	if f.duration <= 0 {
		return ctx, stop
	}
	ctx, cancel := context.WithTimeout(ctx, f.duration)
	return ctx, func() { cancel(); stop() }
}

func runTestStream(args []string) error {
	fs := flag.NewFlagSet("test-stream", flag.ContinueOnError)
	var f streamFlags
	f.registerPublish(fs)
	fs.BoolVar(&f.noAudio, "no-audio", false, "publish video only")
	fs.BoolVar(&f.tone, "tone", true, "play the 440 Hz test tone (false sends silence on the audio track)")
	size := fs.String("size", "", "pretend the source is WxH (e.g. 3440x1440): the layers are fitted to it as for a real monitor")
	testImage, testLabel := testImageFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	preset, layers, enc, err := f.profile()
	if err != nil {
		return err
	}
	if *size != "" {
		var w, h int
		if _, err := fmt.Sscanf(*size, "%dx%d", &w, &h); err != nil || w <= 0 || h <= 0 {
			return fmt.Errorf("--size %q: want WxH, e.g. 3440x1440", *size)
		}
		layers = media.FitLayers(layers, w, h)
	}
	log := f.logger(os.Stderr)
	ctx, cancel := f.context()
	defer cancel()
	if layers, err = f.av1Layers(ctx, preset, layers, enc, log); err != nil {
		return err
	}

	backend, err := media.NewTestBackend()
	if err != nil {
		return fmt.Errorf("test source: %w (build without the nogst tag and install GStreamer)", err)
	}
	backend.Image, backend.Label = *testImage, *testLabel
	src := media.Source{ID: "test", Kind: media.SourceTest, Label: backend.SourceLabel()}
	stream, err := backend.Start(ctx, src, media.Profile{Layers: layers, Encoder: enc, Audio: !f.noAudio, GOP: f.gop})
	if err != nil {
		return fmt.Errorf("test source: %w", err)
	}
	defer func() { _ = stream.Stop() }()
	if ts, ok := stream.(interface {
		SetTone(bool)
		Encoder() media.Encoder
	}); ok {
		ts.SetTone(f.tone)
		enc = ts.Encoder()
	}
	log.Info("test source started", "preset", preset.Name, "encoder", enc, "layers", describeLayers(layers), "audio", !f.noAudio)
	// The schema has no "test" source kind; the test pattern stands in for a screen.
	info := protocol.SourceInfo{Kind: protocol.SourceKindScreen, Label: backend.SourceLabel()}
	return publishStream(ctx, &f, log, stream, preset, layers, !f.noAudio, info)
}

// controllable is a stream whose source reports pauses and takes the privacy curtain
// (the Linux capture backend).
type controllable interface {
	Events() <-chan media.SourceEvent
	SetCurtain(on bool)
	Paused() (bool, string)
}

// publishStream publishes a started stream (to the room, or to the loopback receiver),
// announces it, and runs until the context ends, the source ends or the room stops it.
func publishStream(ctx context.Context, f *streamFlags, log *slog.Logger, stream media.Stream, preset media.Preset, layers []media.Layer, audio bool, source protocol.SourceInfo) error {
	var err error
	cfg := rtc.Config{Layers: layers, Audio: audio, Logger: log}
	var sig rtc.Signaler
	var loop *rtc.Loopback
	var live *liveRoom
	maxKbps := totalKbps(layers, audio)
	if f.loopback {
		if loop, err = rtc.NewLoopback(); err != nil {
			return err
		}
		defer func() { _ = loop.Close() }()
		sig = loop
		cfg.SettingEngine = rtc.LoopbackSettings()
		cfg.ICEServers = []webrtc.ICEServer{}
		cfg.TrackPrefix = "loopback"
	} else {
		client, in, err := f.paired()
		if err != nil {
			return err
		}
		// Publish before opening the room socket: a hello from this device would replace
		// (4002) the socket of another helper process still streaming here, while publish
		// refuses with helper_busy and leaves it alone.
		settings, err := client.RoomSettings(ctx, f.room)
		if err != nil {
			return fmt.Errorf("room %s: %w", f.room, err)
		}
		if maxKbps, err = fitRoom(settings, preset, layers, audio, &cfg); err != nil {
			return err
		}
		if maxKbps < totalKbps(layers, audio) {
			log.Info("the room caps the bitrate", "maxKbps", maxKbps, "videoMaxKbps", cfg.Rate.MaxKbps)
		}
		sig = &api.Signaler{Client: client, RoomID: f.room, Preset: preset.Protocol, MaxBitrateKbps: maxKbps}
		cfg.ICEServers = iceServers(ctx, client, f.room, log)
		live = &liveRoom{client: client, roomID: f.room, opts: api.RoomOptions{DeviceID: in.DeviceID, ClientVersion: version}, log: log}
	}

	pub, err := rtc.Publish(ctx, cfg, stream, sig)
	if err != nil {
		return err
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := pub.Close(cctx); err != nil {
			log.Warn("unpublish", "err", explain(err))
		}
	}()
	log.Info("published", "session", pub.SessionID(), "tracks", fmt.Sprintf("%+v", pub.Tracks()))

	if live != nil {
		// stream.announce goes on a socket of the same device (PROTOCOL.md §7.2).
		if live.conn, err = api.DialRoom(ctx, live.client, f.room, live.opts); err != nil {
			return fmt.Errorf("room socket: %w", err)
		}
		defer live.close()
		live.pings = newPings(log, pingTarget(stream))
		if err := live.announce(ctx, preset, pub, audio, source, encodedLayers(layers, maxKbps, audio)); err != nil {
			return err
		}
		log.Info("live in the room", "room", f.room, "stream", live.streamID)
		// Runs before pub.Close: stream.end, then unpublish (idempotent on the server).
		defer live.end()
	}
	// The card's snapshot every 10 s, as from the web's Go live.
	thumbs := startThumbnails(live, stream, layers, log)
	defer thumbs.Stop()
	hidden := false

	var pli <-chan time.Time
	if loop != nil && f.pliEvery > 0 {
		t := time.NewTicker(f.pliEvery)
		defer t.Stop()
		pli = t.C
	}
	ctrl, _ := stream.(controllable)
	var srcEvents <-chan media.SourceEvent
	curtain := make(chan os.Signal, 1)
	if ctrl != nil {
		srcEvents = ctrl.Events()
		// SIGUSR1 toggles the privacy curtain until the tray's global shortcut exists.
		signal.Notify(curtain, syscall.SIGUSR1)
		defer signal.Stop(curtain)
		if paused, reason := ctrl.Paused(); paused && live != nil {
			live.update(ctx, true, protocol.PauseReason(reason))
		}
	}
	curtainOn := false
	stats := newStatsLogger(log, layers, pub, loop)
	if cs, ok := stream.(captureStatser); ok {
		stats.capture = cs
		stats.prevCapture = cs.CaptureStats()
	}
	tick := time.NewTicker(f.statsEvery)
	defer tick.Stop()
	for {
		var events <-chan protocol.Payload
		var roomDone <-chan struct{}
		if live != nil {
			events, roomDone = live.conn.Events(), live.conn.Done()
		}
		select {
		case <-ctx.Done():
			log.Info("stopping")
			return nil
		case err := <-stream.Err():
			if errors.Is(err, media.ErrSourceEnded) {
				log.Info("the shared source ended (window closed or sharing stopped from the desktop)")
				return nil
			}
			return err
		case ev := <-srcEvents:
			if ev.Resized {
				log.Info("the source was resized; scaled into the same output size", "size", fmt.Sprintf("%dx%d", ev.Width, ev.Height))
				continue
			}
			hidden = ev.Paused
			thumbs.SetPaused(curtainOn || hidden)
			if live != nil {
				live.update(ctx, ev.Paused, ev.PauseReason)
			}
		case <-curtain:
			curtainOn = !curtainOn
			log.Info("privacy curtain", "on", curtainOn)
			thumbs.SetPaused(curtainOn || hidden)
			ctrl.SetCurtain(curtainOn)
		case <-pub.Done():
			return pub.Err()
		case <-tick.C:
			stats.emit()
		case <-pli:
			// The top layer of each video track (f, and af with AV1).
			for _, c := range []media.Codec{media.CodecH264, media.CodecAV1} {
				track := media.LayersOf(layers, c)
				if len(track) == 0 {
					continue
				}
				top := track[0].RID
				if err := loop.SendPLI(top); err != nil {
					log.Warn("loopback PLI", "err", err)
				} else {
					log.Info("loopback receiver sent a PLI", "rid", top)
				}
			}
		case ev, ok := <-events:
			if !ok {
				continue // roomDone is closed too
			}
			if done, err := live.handle(ev); done {
				return err
			}
		case <-roomDone:
			if err := live.resume(ctx); err != nil {
				return err
			}
		}
	}
}

// liveRoom is the helper's room socket while it streams, across reconnects.
type liveRoom struct {
	client   *api.Client
	roomID   string
	opts     api.RoomOptions
	log      *slog.Logger
	conn     *api.RoomConn
	streamID string
	// ended: the room already ended the stream, so no stream.end on the way out.
	ended bool
	// onViewers, if set, hears how many people hold a slot on this stream.
	onViewers func(used int)
	// pings draws viewers' pointer pings; nil when this helper cannot (pingOverlay=false).
	pings *overlay.Controller
}

func (l *liveRoom) close() {
	if l.pings != nil {
		l.pings.Close()
	}
	_ = l.conn.Close()
}

// announce sends stream.announce for the published tracks and the layers as encoded
// (PROTOCOL.md §7.2), with pingOverlay when the helper can draw pointer pings (§7.9).
func (l *liveRoom) announce(ctx context.Context, preset media.Preset, pub *rtc.Publisher, audio bool, source protocol.SourceInfo, layers *protocol.VideoLayers) error {
	var tracks []protocol.Track
	for _, t := range pub.Tracks() {
		tracks = append(tracks, protocol.Track{Name: t.Name, Kind: protocol.TrackKind(t.Kind), Rids: t.Rids, Codec: api.TrackCodec(t)})
	}
	a := protocol.StreamAnnouncePayload{
		SFUSessionID: pub.SessionID(),
		Source:       source,
		Preset:       preset.Protocol,
		Tracks:       tracks,
		HasAudio:     audio,
		Layers:       layers,
	}
	if l.pings != nil {
		a.PingOverlay = ptr(true)
	}
	info, err := l.conn.Announce(ctx, a)
	if err != nil {
		return fmt.Errorf("stream.announce: %w", err)
	}
	l.streamID = info.StreamID
	l.followPings(info)
	return nil
}

// followPings opens the ping overlay while the stream allows pings and closes it when the
// streamer turns them off.
func (l *liveRoom) followPings(info protocol.StreamInfo) {
	if l.pings != nil {
		l.pings.SetEnabled(info.Pings != nil && *info.Pings)
	}
}

// update sends stream.update with the pause state (PROTOCOL.md §7.2). A failure is
// logged: the stream goes on either way.
func (l *liveRoom) update(ctx context.Context, paused bool, reason protocol.PauseReason) {
	u := protocol.StreamUpdatePayload{StreamID: l.streamID, Paused: &paused}
	if paused && reason != "" {
		u.PauseReason = &reason
	}
	if err := l.conn.Update(ctx, u); err != nil {
		l.log.Warn("stream.update", "paused", paused, "err", explain(err))
		return
	}
	l.log.Info("stream.update sent", "paused", paused, "reason", reason)
}

// end sends stream.end unless the room already ended the stream.
func (l *liveRoom) end() {
	if l.ended {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := l.conn.End(ctx, l.streamID); err != nil {
		l.log.Warn("stream.end", "err", explain(err))
	}
}

// handle reacts to a room event; done means the test stream is over.
func (l *liveRoom) handle(ev protocol.Payload) (done bool, err error) {
	switch ev := ev.(type) {
	case *protocol.StreamStopPayload:
		if ev.StreamID == l.streamID {
			l.ended = true
			l.log.Info("the room stopped the stream", "reason", ev.Reason)
			return true, nil
		}
	case *protocol.StreamEndedPayload:
		if ev.StreamID == l.streamID {
			l.ended = true
			if ev.Reason == protocol.StreamEndReasonQuotaExhausted {
				return true, explain(&api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeQuotaExhausted}})
			}
			l.log.Info("the room ended the stream", "reason", ev.Reason)
			return true, nil
		}
	case *protocol.StreamUpdatedPayload:
		if ev.Stream.StreamID == l.streamID {
			l.followPings(ev.Stream)
		}
	case *protocol.PointerPingedPayload:
		// The room sends them only to this stream's helper, and only while pings are on.
		if ev.StreamID == l.streamID && l.pings != nil {
			l.pings.Ping(*ev)
		}
	case *protocol.ViewersPayload:
		if ev.StreamID == l.streamID && l.onViewers != nil {
			l.onViewers(ev.Used)
		}
	case *protocol.KickedPayload:
		l.ended = true
		return true, fmt.Errorf("removed from the room (%s)", ev.Reason)
	case *protocol.RoomClosedPayload:
		l.ended = true
		return true, fmt.Errorf("the room closed (%s)", ev.Reason)
	case *protocol.ErrorPayload:
		// Unsolicited errors precede a close (session_expired before 4001).
		l.log.Warn("room error", "code", ev.Code)
	}
	return false, nil
}

// resume reconnects within the room's 15 s grace and keeps the stream; it fails when
// the close is final (4001–4006) or the room lost the stream.
func (l *liveRoom) resume(ctx context.Context) error {
	dropped := time.Now()
	cause := l.conn.Err()
	var ce *api.CloseError
	if errors.As(cause, &ce) && !ce.Reconnect() {
		l.ended = true
		return fmt.Errorf("room socket: %w", cause)
	}
	l.log.Warn("room socket dropped, reconnecting", "err", cause, "grace", api.ReconnectGrace)
	conn, err := api.Resume(ctx, l.client, l.roomID, l.opts, l.streamID, dropped)
	if err != nil {
		l.ended = true
		return fmt.Errorf("room socket: %w", err)
	}
	l.conn = conn
	l.log.Info("room socket back, the stream continues", "after", time.Since(dropped).Round(time.Millisecond))
	return nil
}

// audioKbps is the Opus bitrate of the test tone (internal/media/pipeline.go).
const audioKbps = 128

// totalKbps is the stream's bitrate as the room counts it: the H.264 track and the audio.
// The AV1 track is sent on top; a viewer pulls one of the two.
func totalKbps(layers []media.Layer, audio bool) int {
	total, _ := rtc.SumTargets(media.LayersOf(layers, media.CodecH264))
	if audio {
		total += audioKbps
	}
	return total
}

// encodedLayers is what stream.announce and stream.update report (since 1.19): the H.264
// layers as the encoders run them (the source's aspect ratio, the display's frame rate),
// the top one cut to fit maxKbps (the publish's budget, with the audio) as fitRoom's rate
// cap does. Viewers label the layers and size their estimates from it, not from the preset.
func encodedLayers(layers []media.Layer, maxKbps int, audio bool) *protocol.VideoLayers {
	h264 := media.LayersOf(layers, media.CodecH264)
	if len(h264) == 0 {
		return nil
	}
	out := make(protocol.VideoLayers, 0, len(h264))
	for _, l := range h264 {
		out = append(out, protocol.VideoLayer{Rid: l.RID, Width: l.Width, Height: l.Height, FPS: l.FPS, Kbps: l.Kbps})
	}
	if over := totalKbps(layers, audio) - maxKbps; maxKbps > 0 && over > 0 {
		out[0].Kbps = max(h264[0].MinKbps, out[0].Kbps-over, 1)
	}
	return &out
}

// withAV1Share is what all the layers send per 100 kbit/s of the H.264 track: 100 without
// an AV1 track, ~165 with one.
func withAV1Share(layers []media.Layer) int {
	h264, _ := rtc.SumTargets(media.LayersOf(layers, media.CodecH264))
	all, _ := rtc.SumTargets(layers)
	if h264 == 0 {
		return 100
	}
	return all * 100 / h264
}

// fitRoom checks the preset against the room's settings and caps the send rate to the
// room's maxBitrateKbps; it returns the publish's maxBitrateKbps (the H.264 layers and
// audio: totalKbps).
func fitRoom(settings protocol.RoomSettings, preset media.Preset, layers []media.Layer, audio bool, cfg *rtc.Config) (int, error) {
	if !slices.Contains(settings.AllowedPresets, preset.Protocol) {
		return 0, explain(&api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodePresetNotAllowed, Preset: &preset.Protocol}})
	}
	total := totalKbps(layers, audio)
	if settings.MaxBitrateKbps <= 0 || total <= settings.MaxBitrateKbps {
		return total, nil
	}
	h264 := media.LayersOf(layers, media.CodecH264)
	_, minimum := rtc.SumTargets(h264)
	video := settings.MaxBitrateKbps - (total - totalKbps(layers, false))
	if video < minimum {
		limit := settings.MaxBitrateKbps
		return 0, explain(&api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeBitrateNotAllowed, Limit: &limit}})
	}
	// The cap is the H.264 track's; the AV1 track gets the same share of its own targets.
	cfg.Rate.MaxKbps = video * withAV1Share(layers) / 100
	return settings.MaxBitrateKbps, nil
}

func describeLayers(layers []media.Layer) []string {
	var out []string
	for _, l := range layers {
		out = append(out, fmt.Sprintf("%s=%dx%d@%d/%dk", l.RID, l.Width, l.Height, l.FPS, l.Kbps))
	}
	return out
}

// iceServers fetches the room's STUN and TURN servers; without them the helper still
// tries the default STUN server.
func iceServers(ctx context.Context, c *api.Client, roomID string, log *slog.Logger) []webrtc.ICEServer {
	servers, err := c.ICEServers(ctx, roomID)
	if err != nil || len(servers) == 0 {
		log.Warn("no ICE servers from the instance, using the default STUN server", "err", explain(err))
		return nil
	}
	var out []webrtc.ICEServer
	for _, s := range servers {
		ice := webrtc.ICEServer{URLs: s.Urls}
		if s.Username != nil {
			ice.Username = *s.Username
		}
		if s.Credential != nil {
			ice.Credential = *s.Credential
		}
		out = append(out, ice)
	}
	return out
}

// captureStatser is a stream that counts captured frames (the Linux backend).
type captureStatser interface{ CaptureStats() media.CaptureStats }

// statsLogger logs per-layer rates since the previous call.
type statsLogger struct {
	capture     captureStatser
	prevCapture media.CaptureStats
	out         *slog.Logger
	layers      []media.Layer
	pub         *rtc.Publisher
	loop        *rtc.Loopback
	prev        rtc.Stats
	prevRx      rtc.LoopbackStats
	at          time.Time
}

func newStatsLogger(log *slog.Logger, layers []media.Layer, pub *rtc.Publisher, loop *rtc.Loopback) *statsLogger {
	s := &statsLogger{out: log, layers: layers, pub: pub, loop: loop, prev: pub.Stats(), at: time.Now()}
	if loop != nil {
		s.prevRx = loop.Stats()
	}
	return s
}

func (s *statsLogger) emit() {
	now := time.Now()
	secs := now.Sub(s.at).Seconds()
	cur := s.pub.Stats()
	var rx rtc.LoopbackStats
	if s.loop != nil {
		rx = s.loop.Stats()
	}
	for i, l := range cur.Layers {
		p := s.prev.Layers[i]
		attrs := []any{
			"rid", l.RID,
			"fps", fmt.Sprintf("%.1f", float64(l.Frames-p.Frames)/secs),
			"kbps", int(float64(l.Bytes-p.Bytes) * 8 / secs / 1000),
			"targetKbps", l.TargetKbps,
			"keyframes", l.Keyframes - p.Keyframes,
			"forcedIdrs", l.ForcedIDRs - p.ForcedIDRs,
		}
		if n := l.PLIs + l.FIRs - p.PLIs - p.FIRs; n > 0 {
			attrs = append(attrs, "keyframeRequests", n, "requesters", l.Requesters)
		}
		if l.LastIDRDelay > 0 {
			attrs = append(attrs, "lastIdrDelay", l.LastIDRDelay.Round(100*time.Microsecond))
		}
		if s.loop != nil {
			attrs = append(attrs, "rxPackets", rx.Packets[l.RID]-s.prevRx.Packets[l.RID])
		}
		s.out.Info("layer", attrs...)
	}
	s.out.Info("send", "estimateKbps", cur.EstimateKbps, "targetKbps", cur.TargetKbps, "watchdogCapKbps", cur.CeilingKbps,
		"lossPct", fmt.Sprintf("%.1f", cur.Loss*100), "audioPackets", cur.AudioPackets-s.prev.AudioPackets)
	if s.capture != nil {
		c := s.capture.CaptureStats()
		s.out.Info("capture", "fps", fmt.Sprintf("%.1f", float64(c.Captured-s.prevCapture.Captured)/secs),
			"size", fmt.Sprintf("%dx%d", c.Width, c.Height), "restarts", c.Restarts, "audioStreams", c.AudioLinked)
		s.prevCapture = c
	}
	s.prev, s.prevRx, s.at = cur, rx, now
}

// thumbnailRunner is a thumbnail.Runner, or nothing for a stream that is not in a room or
// has no snapshot branch.
type thumbnailRunner interface {
	SetPaused(bool)
	Stop()
}

type noThumbnails struct{}

func (noThumbnails) SetPaused(bool) {}
func (noThumbnails) Stop()          {}

func startThumbnails(live *liveRoom, stream media.Stream, layers []media.Layer, log *slog.Logger) thumbnailRunner {
	src, ok := stream.(thumbnail.Source)
	if live == nil || !ok {
		return noThumbnails{}
	}
	upload := func(ctx context.Context, jpeg []byte, placeholder bool) error {
		return live.client.PutThumbnail(ctx, live.roomID, live.streamID, jpeg, placeholder)
	}
	return thumbnail.Start(src, upload, layers[0].Width, layers[0].Height, log)
}

// vbvUsage is the --vbv help of stream, test-stream and run.
const vbvUsage = "encoder buffer (VBV) as time at the target bitrate; smaller bounds IDR size (125ms: ~70 KB IDRs at 8 Mbit/s), larger keeps quality"

// checkVBV keeps --vbv within what the encoders take sensibly.
func checkVBV(d time.Duration) error {
	if d < 20*time.Millisecond || d > 2*time.Second {
		return fmt.Errorf("--vbv %s is outside 20ms–2s", d)
	}
	return nil
}

// testImageFlags are the development flags that send a still image as the test source (the
// README screenshots, scripts/screenshots).
func testImageFlags(fs *flag.FlagSet) (image, label *string) {
	image = fs.String("test-image", "", "development: the test source sends this PNG or JPEG, scaled to the preset, instead of the pattern")
	label = fs.String("test-label", "", "development: the test source's name in the web (default \"Test pattern\")")
	return image, label
}
