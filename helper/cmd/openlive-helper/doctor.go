// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/henriquefps/openlive/helper/internal/compositor"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/overlay"
)

// runDoctor prints what a bug report about capture or encoding needs: the system, the
// desktop (portal backend, ScreenCast, shortcuts, tray, KWin), the GPUs and their drivers, GStreamer and its elements, the encoder auto picks and why, and
// a short synthetic encode per available encoder. It reads no configuration and no token,
// so the output can be pasted as it is.
func runDoctor(args []string, w io.Writer) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	duration := fs.Duration("duration", 5*time.Second, "length of each encode test")
	presetName := fs.String("preset", "1080p60", "preset of the encode test (top layer only; 1080p120 or 1440p120 test 120 fps)")
	pattern := fs.String("pattern", "snow", "test pattern (GStreamer videotestsrc: snow, smpte, ball, …); snow's IDR is large, so a tiny one means black frames")
	only := fs.String("encoder", "", "test only this encoder ("+media.EncoderUsage+")")
	noEncode := fs.Bool("no-encode", false, "skip the encode tests")
	vbv := fs.Duration("vbv", media.DefaultVBV, "encoder buffer (VBV) of the encode test")
	verbose := fs.Bool("v", false, "log the pipelines and the backend's steps to stderr")
	if err := fs.Parse(args); err != nil {
		return err
	}
	preset, err := media.FindPreset(*presetName)
	if err != nil {
		return err
	}
	printf := func(format string, a ...any) { _, _ = fmt.Fprintf(w, format, a...) }

	printf("## openlive-helper doctor\n\n")
	printf("helper:   %s (%s/%s, %s)\n", version, runtime.GOOS, runtime.GOARCH, runtime.Version())
	if media.MacAvailable {
		return macDoctor(w)
	}
	printf("kernel:   %s\n", readTrim("/proc/sys/kernel/osrelease"))
	printf("os:       %s\n", osPrettyName("/etc/os-release"))
	printf("session:  %s, desktop %s\n", envOr("XDG_SESSION_TYPE", "?"), envOr("XDG_CURRENT_DESKTOP", "?"))
	if _, err := os.Stat("/.flatpak-info"); err == nil {
		printf("sandbox:  Flatpak\n")
	}

	printf("\n### Desktop\n")
	for _, l := range inspectDesktop().lines() {
		printf("%s\n", l)
	}

	printf("pings:    overlay %s\n", overlayVerdict(overlay.Probe()))

	if rates, err := compositor.RefreshRates(context.Background()); err == nil {
		for _, name := range slices.Sorted(maps.Keys(rates)) {
			printf("monitor:  %s at %.2f Hz%s\n", name, rates[name], slowMonitor(rates[name]))
		}
	}

	printf("\n### GPUs\n")
	gpus := listGPUs("/sys/class/drm")
	if len(gpus) == 0 {
		printf("no DRM render node\n")
	}
	for _, g := range gpus {
		printf("%s: %s (%s:%s), driver %s\n", g.node, g.vendorName(), g.vendor, g.device, g.driver)
	}
	if v := readTrim("/proc/driver/nvidia/version"); v != "" {
		printf("nvidia:   %s\n", firstLine(v))
	}
	if out, err := exec.Command("vainfo").CombinedOutput(); err == nil || len(out) > 0 {
		for _, l := range vainfoSummary(string(out)) {
			printf("vainfo:   %s\n", l)
		}
	} else {
		printf("vainfo:   not installed\n")
	}

	printf("\n### GStreamer\n")
	if !media.GStreamerAvailable {
		printf("not in this build (nogst)\n")
		return nil
	}
	printf("version:  %s\n", media.GStreamerVersion())
	printf("%s\n", gstreamerVerdict(media.GStreamerVersion()))
	for _, e := range []string{"nvh264enc", "cudaupload", "vah264enc", "vah264lpenc", "vapostproc", "x264enc",
		"nvav1enc", "vaav1enc", "vaav1lpenc", "av1parse",
		"glupload", "glvideomixer", "gldownload", "pipewiresrc", "proxysink", "opusenc"} {
		printf("%-13s %s\n", e+":", yesNo(media.HasElement(e)))
	}

	found := media.DetectEncoders(media.HasElement)
	printf("\n### Encoder selection\n")
	auto, err := media.ResolveEncoder(media.EncoderAuto, media.HasElement)
	if err != nil {
		printf("auto:     none (%v)\n", err)
	} else {
		printf("auto:     %s (the first available of nvh264 → va → va-lp → x264)\n", auto)
		printf("path:     %s capture path\n", media.ResolveCapturePath(media.PathAuto, auto, media.HasElement))
		if !auto.Hardware() {
			printf("warning:  no hardware H.264 encoder; x264 on the CPU will not hold 1080p60\n")
		}
	}
	av1 := media.DetectAV1Encoders(media.HasElement)
	if len(av1) == 0 {
		printf("av1:      none (the AV1 track needs nvav1enc on an RTX 40 or newer, or VA-API's vaav1enc; streams stay H.264)\n")
	} else {
		printf("av1:      %v (used with the H.264 encoder of the same family)\n", av1)
	}
	if *noEncode {
		return nil
	}

	var encoders []media.Encoder
	if *only != "" {
		e, err := media.ParseEncoder(*only)
		if err != nil {
			return err
		}
		if e, err = media.ResolveEncoder(e, media.HasElement); err != nil {
			return err
		}
		encoders = []media.Encoder{e}
	} else {
		encoders = found
	}
	layers, err := preset.Layers([]string{"f"})
	if err != nil {
		return err
	}
	layers = media.WithVBV(layers, *vbv)
	l := layers[0]
	printf("\n### Encode tests (%s, %dx%d@%d, %d kbit/s, VBV %s, pattern %s, %s each)\n", preset.Name, l.Width, l.Height, l.FPS, l.Kbps, *vbv, *pattern, *duration)
	for _, e := range encoders {
		log := slog.New(slog.DiscardHandler)
		if *verbose {
			log = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
		}
		r := encodeTest(e, layers, *pattern, *duration, log)
		printf("%s\n", r)
		// The family's AV1 encoder, on the same layer (the AV1 track's one layer, saving data).
		if a, err := media.ResolveAV1(e, media.HasElement); err == nil {
			r := encodeTest(e, media.AV1Layers(layers, media.AV1SavePercent), *pattern, *duration, log)
			r.encoder = a
			printf("%s\n", r)
		}
	}
	if l.FPS > 60 {
		printf("\nAt %d fps an encoder holds the preset when it encodes at least %d fps; the SPS level must be at least the layer's (H.264 Table A-1).", l.FPS, holdFPS(l.FPS))
	}
	printf("\nA forced IDR should arrive within a few frames; \"unrequested IDRs\" after the bitrate change mean the encoder restarts its GOP on a bitrate change (VA-API does: the helper spaces its changes 3 s apart).\n")
	return nil
}

// encodeResult is one encoder's synthetic run.
type encodeResult struct {
	encoder    media.Encoder
	backend    string
	startup    time.Duration
	frames     int
	bytes      int
	elapsed    time.Duration
	idrDelay   time.Duration // forced IDR: request → first keyframe; 0 = none came
	idrBytes   int           // that IDR's size
	unrequired int           // keyframes after the bitrate change that nobody asked for
	captured   int           // frames out of the capture pipeline (Linux pipeline), -1 = unknown
	pattern    string
	wantFPS    int // the layer's fps
	wantLevel  int // the H.264 level the layer needs
	spsLevel   int // the level in the encoder's first SPS; 0 = none seen
	// av1 runs count key frames, and those without a sequence header (a viewer joining on
	// one could not decode it).
	av1, av1Keys, av1KeysBare int
	wantKbps                  int
	err                       error
}

func (r encodeResult) String() string {
	if r.err != nil && r.frames == 0 {
		return fmt.Sprintf("- %s (%s): FAILED: %v", r.encoder, r.backend, r.err)
	}
	secs := r.elapsed.Seconds()
	fps, kbps := 0.0, 0.0
	if secs > 0 {
		fps, kbps = float64(r.frames)/secs, float64(r.bytes)*8/1000/secs
	}
	idr := "none within 1 s"
	if r.idrDelay > 0 {
		idr = fmt.Sprintf("%s (%d KB)", r.idrDelay.Round(time.Millisecond), r.idrBytes/1000)
	}
	s := fmt.Sprintf("- %s (%s): first frame %s, %.1f fps encoded, %.0f kbit/s, forced IDR %s, unrequested IDRs after a bitrate change %d",
		r.encoder, r.backend, r.startup.Round(time.Millisecond), fps, kbps, idr, r.unrequired)
	if r.captured >= 0 && secs > 0 {
		s += fmt.Sprintf(", %.1f fps captured", float64(r.captured)/secs)
	}
	if r.spsLevel > 0 {
		s += fmt.Sprintf(", SPS level %s (the layer needs %s)", media.LevelName(r.spsLevel), media.LevelName(r.wantLevel))
	}
	if r.av1 > 0 {
		s += fmt.Sprintf(", %d key frames, %d without a sequence header", r.av1Keys, r.av1KeysBare)
		if r.av1KeysBare > 0 {
			s += "\n  warning: a viewer that joins on a key frame without a sequence header cannot decode it"
		}
		if r.pattern == "snow" && kbps > 1.5*float64(r.wantKbps) {
			s += fmt.Sprintf("\n  note: %.0f kbit/s for a %d kbit/s target: on pure noise NVENC AV1 is at its highest quantizer "+
				"(measured ~16.5 Mbit/s at 1080p60 whatever the target); real content holds the target, check with --pattern smpte", kbps, r.wantKbps)
		}
	}
	if secs > 0 && r.wantFPS > 60 {
		if fps >= float64(holdFPS(r.wantFPS)) {
			s += fmt.Sprintf("\n  holds %d fps", r.wantFPS)
		} else {
			s += fmt.Sprintf("\n  warning: does not hold %d fps at this size (%.1f encoded); use a 60 fps preset with this encoder", r.wantFPS, fps)
		}
	}
	if r.spsLevel > 0 && r.wantLevel > 0 && r.spsLevel < r.wantLevel {
		s += fmt.Sprintf("\n  warning: the encoder signals level %s, below the %s this size and rate need; strict decoders (iOS) may refuse it",
			media.LevelName(r.spsLevel), media.LevelName(r.wantLevel))
	}
	if r.err != nil {
		s += fmt.Sprintf(", error: %v", r.err)
	}
	if r.pattern == "snow" && r.idrBytes > 0 && r.idrBytes < 20_000 {
		s += "\n  warning: a snow IDR this small means the encoder got black frames: the test pattern's upload to GL came out black " +
			"(seen with NVIDIA on Wayland EGL; real captures are not affected; rerun with GST_GL_WINDOW=x11, helper/README.md \"Encoders\")"
	}
	return s
}

// encodeTest runs the real encoder pipeline (the Linux backend's, fed by a test pattern
// instead of the portal; the test backend where that one is not built) for d: frames,
// bitrate, a forced IDR at a third of the run, and a bitrate change at two thirds.
func encodeTest(enc media.Encoder, layers []media.Layer, pattern string, d time.Duration, log *slog.Logger) encodeResult {
	r := encodeResult{encoder: enc, captured: -1, pattern: pattern, wantFPS: layers[0].FPS, wantLevel: layers[0].H264Level()}
	if layers[0].IsAV1() {
		r.wantLevel, r.av1, r.wantKbps = 0, 1, layers[0].Kbps
	}
	var backend media.MediaBackend
	if media.LinuxAvailable {
		b, err := media.NewLinuxBackend(media.LinuxOptions{TestPattern: pattern, Log: log})
		if err != nil {
			r.err = err
			return r
		}
		backend, r.backend = b, "linux pipeline"
	} else {
		b, err := media.NewTestBackend()
		if err != nil {
			r.err = err
			return r
		}
		backend, r.backend = b, "test pipeline"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	t0 := time.Now()
	s, err := backend.Start(ctx, media.Source{ID: "doctor", Kind: media.SourceScreen}, media.Profile{Layers: layers, Encoder: enc, GOP: 10 * time.Second})
	if err != nil {
		r.err = err
		return r
	}
	defer func() { _ = s.Stop() }()
	r.startup = time.Since(t0)
	rid := layers[0].RID
	// Frames encoded while Start waited for the source are queued; they are not this run's.
	drain(s.Video(), 20*time.Millisecond)
	cs, _ := s.(interface{ CaptureStats() media.CaptureStats })
	captured0 := uint64(0)
	if cs != nil {
		captured0 = cs.CaptureStats().Captured
	}
	start := time.Now()
	finish := func() encodeResult {
		r.elapsed = time.Since(start)
		if cs != nil {
			r.captured = int(cs.CaptureStats().Captured - captured0)
		}
		return r
	}

	end := start.Add(d)
	idrAt := start.Add(d / 3)
	rateAt := start.Add(2 * d / 3)
	var requested, changed time.Time
	timer := time.NewTimer(time.Until(idrAt))
	defer timer.Stop()
	for {
		select {
		case f, ok := <-s.Video():
			if !ok {
				r.err = errors.New("the stream ended")
				return finish()
			}
			now := time.Now()
			r.frames++
			r.bytes += len(f.Data)
			if r.spsLevel == 0 && r.av1 == 0 {
				r.spsLevel, _ = media.SPSLevel(f.Data)
			}
			if f.Keyframe && r.av1 > 0 {
				r.av1Keys++
				if !media.AV1KeyHeader(f.Data) {
					r.av1KeysBare++
				}
			}
			if f.Keyframe {
				switch {
				case !requested.IsZero() && r.idrDelay == 0 && now.Sub(requested) < time.Second:
					r.idrDelay, r.idrBytes = now.Sub(requested), len(f.Data)
				case !changed.IsZero():
					r.unrequired++
				}
			}
		case err, ok := <-s.Err():
			if ok && err != nil {
				r.err = err
				return finish()
			}
		case now := <-timer.C:
			switch {
			case requested.IsZero():
				requested = now
				if err := s.RequestKeyframe(rid); err != nil {
					r.err = err
				}
				timer.Reset(time.Until(rateAt))
			case changed.IsZero():
				changed = now
				if err := s.SetBitrate(rid, layers[0].Kbps*3/4); err != nil {
					r.err = err
				}
				timer.Reset(time.Until(end))
			default:
				return finish()
			}
		}
	}
}

// drain drops what ch already holds, until it stays empty for quiet.
func drain(ch <-chan media.EncodedFrame, quiet time.Duration) {
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-time.After(quiet):
			return
		}
	}
}

// gpu is one DRM render node.
type gpu struct {
	node, vendor, device, driver string
}

func (g gpu) vendorName() string {
	switch g.vendor {
	case "0x10de":
		return "NVIDIA"
	case "0x1002":
		return "AMD"
	case "0x8086":
		return "Intel"
	}
	return "unknown vendor"
}

// listGPUs reads the render nodes under a sysfs DRM directory.
func listGPUs(root string) []gpu {
	nodes, _ := filepath.Glob(filepath.Join(root, "renderD*"))
	var out []gpu
	for _, n := range nodes {
		dev := filepath.Join(n, "device")
		g := gpu{node: filepath.Base(n), vendor: readTrim(filepath.Join(dev, "vendor")), device: readTrim(filepath.Join(dev, "device")), driver: "?"}
		if link, err := os.Readlink(filepath.Join(dev, "driver")); err == nil {
			g.driver = filepath.Base(link)
		}
		out = append(out, g)
	}
	return out
}

// vainfoSummary keeps vainfo's driver line and its H.264 encode entrypoints.
func vainfoSummary(out string) []string {
	var keep []string
	encode := false
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case strings.Contains(line, "Driver version"):
			keep = append(keep, strings.TrimSpace(strings.TrimPrefix(line, "vainfo:")))
		case strings.HasPrefix(line, "VAProfileH264") && strings.Contains(line, "VAEntrypointEncSlice"):
			keep = append(keep, strings.Join(strings.Fields(line), " "))
			encode = true
		case strings.Contains(line, "error") || strings.Contains(line, "failed"):
			keep = append(keep, line)
		}
	}
	if !encode {
		keep = append(keep, "no H.264 encode entrypoint (VAEntrypointEncSlice*)")
	}
	return keep
}

// osPrettyName is PRETTY_NAME from an os-release file.
func osPrettyName(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "?"
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		if v, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
			return strings.Trim(v, `"`)
		}
	}
	return "?"
}

func readTrim(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// holdFPS is the encoded rate at which an encoder counts as holding fps: 95 %.
func holdFPS(fps int) int { return fps * 95 / 100 }

// slowMonitor notes a monitor below the 120 fps presets' rate.
func slowMonitor(hz float64) string {
	if math.Round(hz) < media.MaxFPS {
		return fmt.Sprintf(" (a %d fps preset captures at %.0f fps here)", media.MaxFPS, math.Round(hz))
	}
	return ""
}
