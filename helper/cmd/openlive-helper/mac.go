// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"

	"github.com/henriquefps/openlive/helper/internal/media"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The macOS side of the commands: the capture sidecar (media.MacBackend) behind "run",
// "stream" and "doctor". These only run where media.MacAvailable is true, but build on every
// unix so Linux CI compiles and tests them.

// macFlags are the capture flags the macOS backend reads.
type macFlags struct {
	hideCursor  bool
	testPattern string
	testSize    string
	audioApp    string
}

// options turns the flags into the backend's options. Any --test-pattern shows the
// sidecar's moving test window (--test-size, default 1280x720) on the display.
func (f macFlags) options(log *slog.Logger) media.MacOptions {
	o := media.MacOptions{AudioApp: f.audioApp, HideCursor: f.hideCursor, Thumbnails: true, Log: log}
	if f.testPattern != "" {
		o.Animate = f.testSize
		if o.Animate == "" {
			o.Animate = "1280x720"
		}
	}
	return o
}

// macScreen is run's screen backend on macOS: one sidecar backend per stream (its audio app
// is fixed per backend), and the first one for the picker's thumbnails.
func macScreen(f macFlags, log *slog.Logger) (func(audioApp string) (media.MediaBackend, error), media.Thumbnailer, error) {
	b, err := media.NewMacBackend(f.options(log))
	if err != nil {
		return nil, nil, fmt.Errorf("screen capture: %w", err)
	}
	return func(audioApp string) (media.MediaBackend, error) {
		o := f.options(log)
		o.AudioApp, o.Sidecar = audioApp, b.Sidecar()
		return media.NewMacBackend(o)
	}, b, nil
}

// macSource picks the source of "stream": "monitor" (the main display), "display:<id>" or
// "window:<id>" (from --list-sources).
func macSource(ctx context.Context, b *media.MacBackend, want string) (media.Source, error) {
	srcs, err := b.Sources(ctx)
	if err != nil {
		return media.Source{}, err
	}
	list := media.MacSourceList(srcs)
	switch want {
	case "monitor", "screen", "display":
		for _, d := range srcs.Displays {
			if d.Main {
				return list[findSource(list, media.MacDisplayID(d.ID))], nil
			}
		}
		if len(srcs.Displays) > 0 {
			return list[0], nil
		}
		return media.Source{}, errors.New("no display to capture")
	case "window":
		return media.Source{}, errors.New("--source window: name the window, --source window:<id> (see --list-sources)")
	}
	if i := findSource(list, want); i >= 0 {
		return list[i], nil
	}
	return media.Source{}, fmt.Errorf("no source %q (see --list-sources)", want)
}

func findSource(list []media.Source, id string) int {
	for i, s := range list {
		if s.ID == id {
			return i
		}
	}
	return -1
}

func printMacSources(ctx context.Context, b *media.MacBackend, w io.Writer) error {
	srcs, err := b.Sources(ctx)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(w, "Sources (use the id with --source):")
	for _, s := range media.MacSourceList(srcs) {
		_, _ = fmt.Fprintf(w, "  %-16s %-6s %4dx%-4d %s\n", s.ID, s.Kind, s.Width, s.Height, s.Label)
	}
	return nil
}

func printMacApps(ctx context.Context, b *media.MacBackend, w io.Writer) error {
	srcs, err := b.Sources(ctx)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(w, "Running apps (use the name or the bundle id with --audio-app):")
	for _, a := range srcs.Apps {
		_, _ = fmt.Fprintf(w, "  %-32s %-40s pid %d\n", a.Name, a.BundleID, a.PID)
	}
	return nil
}

// runMacStream is "stream" on macOS.
func runMacStream(f *captureFlags) error {
	log := f.logger(os.Stderr)
	b, err := media.NewMacBackend(macFlags{hideCursor: f.hideCursor, testPattern: f.testPattern, testSize: f.testSize, audioApp: f.audioApp}.options(log))
	if err != nil {
		return fmt.Errorf("screen capture: %w", err)
	}
	ctx, cancel := f.context()
	defer cancel()
	if f.listApps {
		return printMacApps(ctx, b, os.Stdout)
	}
	if f.listSources {
		return printMacSources(ctx, b, os.Stdout)
	}
	preset, layers, enc, err := f.profile()
	if err != nil {
		return err
	}
	src, err := macSource(ctx, b, f.source)
	if err != nil {
		return err
	}
	if layers, err = f.av1Layers(ctx, preset, layers, enc, log); err != nil {
		return err
	}
	withAudio := f.audioApp != ""
	stream, err := b.Start(ctx, src, media.Profile{Layers: layers, Encoder: enc, Audio: withAudio, GOP: f.gop})
	if err != nil {
		return fmt.Errorf("screen capture: %w", err)
	}
	defer func() { _ = stream.Stop() }()
	if l, ok := stream.(interface{ Layers() []media.Layer }); ok {
		layers = l.Layers()
	}
	info := protocol.SourceInfo{Kind: protocol.SourceKindScreen, Label: protocol.Label(src.Label)}
	if src.Kind == media.SourceWindow {
		info.Kind = protocol.SourceKindWindow
	}
	// Always show what is being shared.
	log.Info("sharing", "source", src.ID, "label", src.Label, "size", fmt.Sprintf("%dx%d", src.Width, src.Height))
	if app := audioAppOf(stream); app != nil {
		log.Info("audio from", "app", app.Name, "bundle", deref(app.Binary))
	}
	log.Info("capture started", "preset", preset.Name, "encoder", media.EncoderVideoToolbox, "layers", describeLayers(layers), "audioApp", f.audioApp)
	return publishStream(ctx, &f.streamFlags, log, stream, preset, layers, withAudio, info)
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

// macDoctor is "doctor" on macOS: the system, the Screen Recording permission, VideoToolbox's
// encoders and the sidecar.
func macDoctor(w io.Writer) error {
	printf := func(format string, a ...any) { _, _ = fmt.Fprintf(w, format, a...) }
	printf("\n### macOS capture\n")
	b, err := media.NewMacBackend(media.MacOptions{})
	if err != nil {
		printf("sidecar:  missing (%v)\n", err)
		return nil
	}
	printf("sidecar:  %s\n", b.Sidecar())
	d, err := b.Doctor(context.Background())
	if err != nil {
		printf("doctor:   %v\n", err)
		return nil
	}
	printf("macOS:    %s%s\n", d.MacOS, macVersionVerdict(d.MacOS))
	if d.ScreenRecording {
		printf("screen recording: granted\n")
	} else {
		printf("screen recording: NOT granted to this process (System Settings > Privacy & Security > Screen & System Audio Recording; the app that started the helper, or openlive-helper itself, needs the switch on)\n")
	}
	var h264, hevc []string
	for _, e := range d.Encoders {
		switch e.Codec {
		case "avc1":
			h264 = append(h264, fmt.Sprintf("%s%s", e.Name, hwMark(e.Hardware)))
		case "hvc1":
			hevc = append(hevc, fmt.Sprintf("%s%s", e.Name, hwMark(e.Hardware)))
		}
	}
	printf("h264:     %s\n", strings.Join(h264, ", "))
	printf("hevc:     %s\n", strings.Join(hevc, ", "))
	if d.LowLatencyH264 {
		printf("encoder:  vt (VideoToolbox H.264, hardware, low-latency rate control): ok\n")
	} else {
		printf("encoder:  vt cannot open a low-latency hardware H.264 session: %s\n", d.LowLatencyError)
	}
	if d.AV1Hardware {
		printf("av1:      VideoToolbox lists a hardware AV1 encoder, but this helper does not use it yet: --av1 auto stays H.264\n")
	} else {
		printf("av1:      no hardware AV1 encoder on macOS: --av1 auto resolves to off (H.264 only), --av1 on fails\n")
	}
	return nil
}

func hwMark(hw bool) string {
	if hw {
		return " (hardware)"
	}
	return ""
}

// macVersionVerdict flags a macOS older than the sidecar supports.
func macVersionVerdict(v string) string {
	var major int
	if _, err := fmt.Sscanf(v, "%d", &major); err != nil || major >= media.MinMacOS {
		return ""
	}
	return fmt.Sprintf(" (too old: needs macOS %d or later)", media.MinMacOS)
}
