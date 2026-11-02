// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/henriquefps/openlive/helper/internal/audio"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/portal"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

type captureFlags struct {
	streamFlags
	source      string
	audioApp    string
	listApps    bool
	listSources bool
	pick        bool
	windowHint  string
	stillPause  time.Duration
	capturePath string
	hideCursor  bool
	testPattern string
	testSize    string
}

// runStream streams a real monitor or window from the CLI (the web control arrives with
// the hub client): openlive-helper stream --room <id> --source monitor|window [--audio-app <name>].
// On macOS --source also takes a display:<id> or window:<id> from --list-sources.
func runStream(args []string) error {
	fs := flag.NewFlagSet("stream", flag.ContinueOnError)
	var f captureFlags
	f.registerPublish(fs)
	fs.StringVar(&f.source, "source", "monitor", "monitor or window; the system dialog asks which one the first time (macOS: monitor, display:<id> or window:<id>)")
	fs.BoolVar(&f.listSources, "list-sources", false, "macOS: list the displays and windows and exit")
	fs.StringVar(&f.audioApp, "audio-app", "", "publish the audio of this app only (a name from --list-audio-apps), or \"window\" for the shared window's app; empty: no audio")
	fs.BoolVar(&f.listApps, "list-audio-apps", false, "list the apps playing audio now and exit")
	fs.BoolVar(&f.pick, "pick", false, "ask again in the system dialog instead of restoring the last choice")
	fs.StringVar(&f.windowHint, "window-hint", "", "part of the shared window's title or app, to tell windows of the same size apart")
	fs.DurationVar(&f.stillPause, "still-pause", 0, "mark the stream paused when the picture has not changed for this long (0: off)")
	fs.StringVar(&f.capturePath, "capture-path", "auto", "auto, gl (GPU scaling) or cpu (software; does not hold 1080p60)")
	fs.BoolVar(&f.hideCursor, "hide-cursor", false, "leave the mouse cursor out of the picture")
	fs.StringVar(&f.testPattern, "test-pattern", "", "development: capture a videotestsrc pattern (e.g. ball) instead of the portal; on macOS any value shows the sidecar's moving test window")
	fs.StringVar(&f.testSize, "test-size", "", "development, macOS: the moving test window's size, WxH (default 1280x720)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if media.MacAvailable {
		return runMacStream(&f)
	}
	if f.listApps {
		return listAudioApps(context.Background())
	}
	kind, err := portal.ParseKind(f.source)
	if err != nil {
		return err
	}
	preset, layers, enc, err := f.profile()
	if err != nil {
		return err
	}
	path, err := media.ParseCapturePath(f.capturePath)
	if err != nil {
		return err
	}
	dir, err := f.dir()
	if err != nil {
		return err
	}
	log := f.logger(os.Stderr)
	ctx, cancel := f.context()
	defer cancel()
	if layers, err = f.av1Layers(ctx, preset, layers, enc, log); err != nil {
		return err
	}

	backend, err := media.NewLinuxBackend(media.LinuxOptions{
		Store:       portal.Store{Path: portal.StorePath(dir)},
		Pick:        f.pick,
		WindowHint:  f.windowHint,
		AudioApp:    f.audioApp,
		StillPause:  f.stillPause,
		Path:        path,
		HideCursor:  f.hideCursor,
		TestPattern: f.testPattern,
		Log:         log,
	})
	if err != nil {
		return fmt.Errorf("screen capture: %w (needs Linux, and a build without the nogst tag)", err)
	}
	src := media.Source{ID: kind.String(), Kind: media.SourceScreen}
	if kind == portal.KindWindow {
		src.Kind = media.SourceWindow
	}
	withAudio := f.audioApp != ""
	stream, err := backend.Start(ctx, src, media.Profile{Layers: layers, Encoder: enc, Audio: withAudio, GOP: f.gop})
	if errors.Is(err, portal.ErrCancelled) {
		return err
	}
	if err != nil {
		return fmt.Errorf("screen capture: %w", err)
	}
	defer func() { _ = stream.Stop() }()

	info := protocol.SourceInfo{Kind: protocol.SourceKindScreen, Label: "Screen"}
	if s, ok := stream.(interface {
		SharedSource() portal.Source
		Layers() []media.Layer
		Encoder() media.Encoder
	}); ok {
		shared := s.SharedSource()
		if shared.Kind == portal.KindWindow {
			info.Kind = protocol.SourceKindWindow
		}
		info.Label = protocol.Label(shared.Label)
		layers, enc = s.Layers(), s.Encoder()
		// Always show what is being shared.
		log.Info("sharing", "source", shared.Kind, "label", shared.Label, "size", fmt.Sprintf("%dx%d", shared.Width, shared.Height))
	}
	log.Info("capture started", "preset", preset.Name, "encoder", enc, "layers", describeLayers(layers), "audioApp", f.audioApp)
	return publishStream(ctx, &f.streamFlags, log, stream, preset, layers, withAudio, info)
}

func listAudioApps(ctx context.Context) error {
	apps, err := audio.ListApps(ctx)
	if err != nil {
		return err
	}
	if len(apps) == 0 {
		fmt.Println("No app is playing audio now.")
		return nil
	}
	fmt.Println("Apps playing audio (use the name with --audio-app):")
	for _, a := range apps {
		var pids []string
		for _, p := range a.PIDs {
			pids = append(pids, fmt.Sprint(p))
		}
		fmt.Printf("  %-32s binary %-20s pid %s, %d stream(s)\n", a.Name, a.Binary, strings.Join(pids, ","), len(a.Nodes))
	}
	return nil
}
