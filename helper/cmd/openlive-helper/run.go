// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/i18n"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/portal"
	"github.com/henriquefps/openlive/helper/internal/single"
	"github.com/henriquefps/openlive/helper/internal/store"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// runHub is the long-running mode: stay connected to the user hub and stream what the web
// asks for. The web lists the Linux backend's monitor and window (picked in
// the system dialog), or on macOS every display and window (the capture sidecar), and, with
// --test-source or where neither backend is built, the synthetic test pattern.
func runHub(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	var f common
	f.register(fs)
	layers := fs.String("layers", "f,h,q", "simulcast layers to send: f (preset), h (720p60), q (480p30)")
	encoder := fs.String("encoder", "auto", media.EncoderUsage)
	av1 := fs.String("av1", string(media.AV1Auto), "also publish the top layer in AV1 on a second track: "+media.AV1Usage)
	gop := fs.Duration("gop", 10*time.Second, "fallback keyframe interval (keyframes normally come on PLI/FIR)")
	vbv := fs.Duration("vbv", media.DefaultVBV, vbvUsage)
	testSource := fs.Bool("test-source", false, "also offer the synthetic test pattern (always offered without the Linux backend)")
	testImage, testLabel := testImageFlags(fs)
	capturePath := fs.String("capture-path", "auto", "auto, gl (GPU scaling) or cpu (software; does not hold 1080p60)")
	hideCursor := fs.Bool("hide-cursor", false, "leave the mouse cursor out of the picture")
	testPattern := fs.String("test-pattern", "", "development: the Linux backend captures a videotestsrc pattern (e.g. ball) instead of the portal; on macOS any value shows the sidecar's moving test window")
	testSize := fs.String("test-size", "", "development: the --test-pattern's size, WxH (e.g. 1913x1047 to stand in for a window; default the preset's)")
	minimized := fs.Bool("minimized", false, "started with the session (autostart): no \"helper is running\" notification")
	noVoiceSink := fs.Bool("no-voice-sink", false, "do not create the \"Openlive – voice\" sink that keeps voice out of a shared window's audio")
	if err := fs.Parse(args); err != nil {
		return err
	}
	enc, err := media.ParseEncoder(*encoder)
	if err != nil {
		return err
	}
	if err := checkVBV(*vbv); err != nil {
		return err
	}
	av1Mode, err := media.ParseAV1Mode(*av1)
	if err != nil {
		return err
	}
	rids := media.ParseLayers(*layers)
	if _, err := media.Presets[0].Layers(rids); err != nil {
		return err
	}
	path, err := media.ParseCapturePath(*capturePath)
	if err != nil {
		return err
	}
	var testW, testH int
	if *testSize != "" {
		if _, err := fmt.Sscanf(*testSize, "%dx%d", &testW, &testH); err != nil || testW <= 0 || testH <= 0 {
			return fmt.Errorf("--test-size %q: want WxH", *testSize)
		}
	}
	client, in, err := f.paired()
	if err != nil {
		return err
	}
	dir, err := f.dir()
	if err != nil {
		return err
	}
	// One "run" per instance: a second one would fight the first over the hub socket.
	lock, err := single.Acquire(single.Dir(), client.Base.String())
	if err != nil {
		return err
	}
	defer func() { _ = lock.Release() }()
	stored, err := store.LoadConfig(store.ConfigPath(dir))
	if err != nil {
		return err
	}
	log := f.logger(os.Stderr)
	sources := &sourceBackends{}
	if media.LinuxAvailable {
		sources.screen = func(audioApp string) (media.MediaBackend, error) {
			return media.NewLinuxBackend(media.LinuxOptions{
				Store: portal.Store{Path: portal.StorePath(dir)}, AudioApp: audioApp,
				Path: path, HideCursor: *hideCursor, TestPattern: *testPattern, TestWidth: testW, TestHeight: testH, Log: log,
			})
		}
	}
	if media.MacAvailable {
		if sources.screen, sources.thumbs, err = macScreen(macFlags{hideCursor: *hideCursor, testPattern: *testPattern, testSize: *testSize}, log); err != nil {
			return err
		}
	}
	if *testSource || sources.screen == nil {
		test, err := media.NewTestBackend()
		if err != nil {
			return fmt.Errorf("test source: %w (build without the nogst tag and install GStreamer)", err)
		}
		test.Image, test.Label = *testImage, *testLabel
		sources.test, sources.testImage = test, *testImage
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Quit in the tray ends the run like Ctrl+C.
	ctx, quit := context.WithCancel(ctx)
	defer quit()
	var desk *desktop

	cfg := liveConfig{client: client, deviceID: in.DeviceID, rids: rids, encoder: enc, av1: av1Mode, gop: *gop, vbv: *vbv, log: log}
	start := func(ctx context.Context, req protocol.HelperStartStreamPayload, src media.Source) (session, error) {
		c := cfg
		var err error
		if c.backend, err = sources.backendFor(req, src); err != nil {
			return nil, err
		}
		req.Audio = sources.audio(req, src)
		s, err := startLive(ctx, c, req, src)
		if err != nil {
			return nil, err
		}
		desk.streamStarted(req.RoomID, s.RoomName(), s.SourceLabel())
		return s, nil
	}
	ctl := newController(in.DeviceID, sources, start, log)
	defer ctl.shutdown()
	settings := store.Desktop{}
	if stored.Desktop != nil {
		settings = *stored.Desktop
	}
	desk = startDesktop(ctx, ctl, desktopOptions{settings: settings, instance: client.Base.String(), flags: &f, minimized: *minimized, quit: quit, log: log})
	ctl.observe = desk.observe
	cfg.onViewers = desk.viewers
	// After observe is set: the sink reports from its own goroutine.
	if !*noVoiceSink {
		defer startVoiceSink(ctx, ctl, i18n.Detect(settings.Language, nil), log)()
	}

	opts := api.HubOptions{DeviceID: in.DeviceID, ClientVersion: version}
	for attempt := 0; ; {
		hub, err := api.DialHub(ctx, client, opts)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if !api.Retryable(err) {
				return fmt.Errorf("hub: %w", explain(err))
			}
			wait := api.HubBackoff(attempt)
			attempt++
			log.Warn("hub unreachable, retrying", "err", err, "in", wait)
			select {
			case <-time.After(wait):
				continue
			case <-ctx.Done():
				return nil
			}
		}
		attempt = 0
		log.Info("connected to the hub: the web can control this helper", "instance", client.Base.String())
		ctl.attach(ctx, hub)
		desk.online(true)
		serveHub(ctx, ctl, hub)
		ctl.detach(hub)
		desk.online(false)
		if ctx.Err() != nil {
			_ = hub.Close()
			return nil
		}
		cause := hub.Err()
		var ce *api.CloseError
		if errors.As(cause, &ce) && !ce.Reconnect() {
			// Revoked (4001), replaced by another instance of this device (4002) or too old (4006).
			return fmt.Errorf("hub: %w", explain(cause))
		}
		log.Warn("hub connection dropped, reconnecting (a live stream goes on)", "err", cause)
	}
}

// serveHub hands the hub's commands to the controller until the socket closes.
func serveHub(ctx context.Context, ctl *controller, hub *api.HubConn) {
	for {
		select {
		case cmd, ok := <-hub.Commands():
			if !ok {
				return
			}
			ctl.handle(ctx, hub, cmd)
		case <-ctx.Done():
			return
		}
	}
}

// sourceBackends lists the sources of every backend this helper runs and picks the one
// that captures a chosen source.
type sourceBackends struct {
	// screen makes the screen backend (Linux or macOS) for one stream: its audio app is fixed
	// per backend.
	screen func(audioApp string) (media.MediaBackend, error)
	// thumbs grabs stills of the screen backend's sources (macOS; the portal cannot).
	thumbs media.Thumbnailer
	test   media.MediaBackend
	// testImage is the test source's --test-image, for its picker preview.
	testImage string
}

func (b *sourceBackends) ListSources(ctx context.Context) ([]media.Source, error) {
	var out []media.Source
	if b.screen != nil {
		l, err := b.screen("")
		if err != nil {
			return nil, err
		}
		if out, err = l.ListSources(ctx); err != nil {
			return nil, err
		}
	}
	if b.test != nil {
		test, err := b.test.ListSources(ctx)
		if err != nil {
			return nil, err
		}
		out = append(out, test...)
	}
	return out, nil
}

// Thumbnail is a still of a source for the web's picker: the screen backend's when it has
// them, the drawn test pattern for the test source.
func (b *sourceBackends) Thumbnail(ctx context.Context, src media.Source, maxWidth, maxHeight int) (media.Thumbnail, error) {
	if src.Kind == media.SourceTest {
		if b.testImage != "" {
			return imageThumbnail(b.testImage, maxWidth, maxHeight)
		}
		return testPatternThumbnail(maxWidth, maxHeight)
	}
	if b.thumbs == nil {
		return media.Thumbnail{}, errors.New("no thumbnails for this source")
	}
	return b.thumbs.Thumbnail(ctx, src, maxWidth, maxHeight)
}

// Start is not used: the controller starts through backendFor.
func (b *sourceBackends) Start(context.Context, media.Source, media.Profile) (media.Stream, error) {
	return nil, errors.New("start through backendFor")
}

// audio says whether the stream carries audio: the test tone, or a window's own app. A
// whole screen has no app to take the sound from until the backend lists app sources.
func (b *sourceBackends) audio(req protocol.HelperStartStreamPayload, src media.Source) bool {
	return req.Audio && (src.Kind == media.SourceTest || src.Kind == media.SourceWindow)
}

// backendFor is the backend that captures src. A window's own audio is its app's
// ("window"); per-app audio for a whole screen needs app sources, which the portal
// backend does not list yet.
func (b *sourceBackends) backendFor(req protocol.HelperStartStreamPayload, src media.Source) (media.MediaBackend, error) {
	if src.Kind == media.SourceTest {
		if b.test == nil {
			return nil, &api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeSourceNotFound, SourceID: &req.SourceID}}
		}
		return b.test, nil
	}
	if b.screen == nil {
		return nil, &api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeSourceNotFound, SourceID: &req.SourceID}}
	}
	audioApp := ""
	if req.Audio && src.Kind == media.SourceWindow {
		audioApp = "window"
	}
	return b.screen(audioApp)
}
