// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package media

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/audio"
	"github.com/henriquefps/openlive/helper/internal/sidecar"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The macOS backend runs here against a fake sidecar: this test binary, started again with
// fakeSidecarEnv set, plays openlive-capture's side of the protocol (macos-capture/README.md).

const (
	fakeSidecarEnv = "OPENLIVE_FAKE_SIDECAR"
	// fakeLogEnv is a file the fake appends what it received to, one JSON line each.
	fakeLogEnv = "OPENLIVE_FAKE_SIDECAR_LOG"
)

func TestMain(m *testing.M) {
	if mode, ok := os.LookupEnv(fakeSidecarEnv); ok {
		os.Exit(fakeSidecar(mode, os.Args[1:]))
	}
	os.Exit(m.Run())
}

var fakeSources = MacSources{
	Displays: []MacDisplay{{ID: 1, Name: "Wide", Width: 3440, Height: 1440, RefreshHz: 60, Main: true}},
	Windows:  []MacWindow{{ID: 7, Title: "Openlive", App: "Google Chrome", BundleID: "com.google.Chrome", PID: 4242, Width: 1280, Height: 800}},
	Apps:     []sidecar.AppInfo{{Name: "Google Chrome", BundleID: "com.google.Chrome", PID: 4242}, {Name: "Music", BundleID: "com.apple.Music", PID: 77}},
}

func fakeLog(v any) {
	f, err := os.OpenFile(os.Getenv(fakeLogEnv), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	b, _ := json.Marshal(v)
	_, _ = f.Write(append(b, '\n'))
}

// fakeSidecar is openlive-capture's stand-in. mode: "ok", "permission", "ended", "hidden",
// "oldproto".
func fakeSidecar(mode string, args []string) int {
	if len(args) == 0 {
		return 2
	}
	switch args[0] {
	case "list":
		if mode == "permission" {
			fmt.Fprintln(os.Stderr, "openlive-capture: Screen Recording permission is not granted (System Settings > …)")
			return 1
		}
		_ = json.NewEncoder(os.Stdout).Encode(fakeSources)
		return 0
	case "thumbnail":
		_ = jpeg.Encode(os.Stdout, image.NewGray(image.Rect(0, 0, 32, 18)), nil)
		return 0
	case "capture":
	default:
		return 2
	}
	conn := os.NewFile(3, "helper")
	proto := sidecar.ProtocolVersion
	if mode == "oldproto" {
		proto = 99
	}
	fmt.Fprintln(os.Stderr, "openlive-capture: fake sidecar up")
	_ = sidecar.WriteJSON(conn, sidecar.TypeHello, sidecar.Hello{ProtocolVersion: proto, Version: "fake", OS: "test"})
	m, err := sidecar.Read(conn)
	if err != nil || m.Type != sidecar.TypeConfig {
		return 3
	}
	var cfg sidecar.Config
	if err := m.Decode(&cfg); err != nil {
		return 3
	}
	fakeLog(map[string]any{"config": cfg})
	if mode == "permission" {
		_ = sidecar.WriteJSON(conn, sidecar.TypeError, sidecar.Error{Code: "permission", Message: "no", Fatal: true})
		return 1
	}
	var app *sidecar.AppInfo
	if cfg.Audio != nil {
		app = &sidecar.AppInfo{Name: "Google Chrome", BundleID: "com.google.Chrome", PID: cfg.Audio.PID}
	}
	_ = sidecar.WriteJSON(conn, sidecar.TypeStarted, sidecar.Started{Width: cfg.Layers[0].Width, Height: cfg.Layers[0].Height, Encoder: "fake", AudioApp: app})

	controls := make(chan sidecar.Message, 16)
	go func() {
		for {
			m, err := sidecar.Read(conn)
			if err != nil {
				close(controls)
				return
			}
			controls <- m
		}
	}()
	var pts uint64 = 1_000_000_000
	frame := func(layer int, key bool) {
		_ = sidecar.Write(conn, sidecar.TypeVideo, sidecar.Video{Layer: layer, Keyframe: key, PTSNanos: pts, EncodeMicros: 900, Data: []byte{0, 0, 0, 1, 0x65, byte(layer)}}.Payload())
	}
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for n := 0; ; n++ {
		select {
		case m, ok := <-controls:
			if !ok {
				return 0
			}
			if m.Type == sidecar.TypeStop {
				fakeLog(map[string]any{"stop": true})
				return 0
			}
			layer, value, err := sidecar.ParseControl(m)
			if err != nil {
				return 4
			}
			fakeLog(map[string]any{"type": int(m.Type), "layer": layer, "value": value})
			if m.Type == sidecar.TypeKeyframe {
				frame(layer, true)
			}
		case <-tick.C:
			pts += 16_666_667 // 60 fps
			for i := range cfg.Layers {
				frame(i, n == 0)
			}
			if cfg.Audio != nil {
				_ = sidecar.Write(conn, sidecar.TypeAudio, sidecar.Audio{PTSNanos: pts, DurationMicros: 20000, Data: []byte{0xf8, 0xff, 0xfe}}.Payload())
			}
			if n%10 == 0 {
				_ = sidecar.WriteJSON(conn, sidecar.TypeStats, sidecar.Stats{Captured: 60})
				_ = sidecar.Write(conn, sidecar.TypeThumbnail, []byte{0xff, 0xd8, 0xff})
			}
			if n == 3 && mode == "ended" {
				_ = sidecar.WriteJSON(conn, sidecar.TypeEvent, sidecar.Event{Event: "ended"})
			}
			if n == 3 && mode == "hidden" {
				_ = sidecar.WriteJSON(conn, sidecar.TypeEvent, sidecar.Event{Event: "hidden"})
			}
		}
	}
}

func fakeBackend(t *testing.T, mode string, opts MacOptions) (*MacBackend, string) {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), "fake.log")
	t.Setenv(fakeSidecarEnv, mode)
	t.Setenv(fakeLogEnv, logPath)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	opts.Sidecar = exe
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	b, err := NewMacBackend(opts)
	if err != nil {
		t.Fatal(err)
	}
	return b, logPath
}

func readFakeLog(t *testing.T, path string) []map[string]json.RawMessage {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]json.RawMessage
	for line := range strings.SplitSeq(strings.TrimSpace(string(b)), "\n") {
		var m map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func TestMacListSources(t *testing.T) {
	b, _ := fakeBackend(t, "ok", MacOptions{})
	srcs, err := b.ListSources(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []Source{
		{ID: "display:1", Kind: SourceScreen, Label: "Wide (3440x1440)", Width: 3440, Height: 1440},
		{ID: "window:7", Kind: SourceWindow, Label: "Google Chrome – Openlive", AppName: "Google Chrome", Width: 1280, Height: 800, HasAudio: true},
	}
	if fmt.Sprint(srcs) != fmt.Sprint(want) {
		t.Errorf("got  %+v\nwant %+v", srcs, want)
	}
	th, err := b.Thumbnail(context.Background(), srcs[0], 320, 180)
	if err != nil || th.Width != 32 || th.Height != 18 || th.MimeType != "image/jpeg" {
		t.Errorf("thumbnail %dx%d %s %v", th.Width, th.Height, th.MimeType, err)
	}
}

func TestMacListPermission(t *testing.T) {
	b, _ := fakeBackend(t, "permission", MacOptions{})
	if _, err := b.ListSources(context.Background()); !errors.Is(err, ErrScreenRecording) {
		t.Fatalf("err = %v", err)
	}
}

func TestMacStream(t *testing.T) {
	b, logPath := fakeBackend(t, "ok", MacOptions{AudioApp: "google chrome", Thumbnails: true})
	preset, _ := FindPreset("1440p120")
	layers, _ := preset.Layers(AllRIDs)
	s, err := b.Start(context.Background(), Source{ID: "display:1"}, Profile{Layers: layers, Audio: true, GOP: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	// Fitted to the 3440x1440 display and capped at its 60 Hz.
	got := s.(interface{ Layers() []Layer }).Layers()
	if got[0].Width != 3440 || got[0].Height != 1440 || got[0].FPS != 60 || got[1].Width != 1728 || got[1].Height != 720 {
		t.Errorf("layers %+v", got)
	}
	seen := map[string]int{}
	deadline := time.After(5 * time.Second)
	for seen["f"] < 5 || seen["h"] < 5 || seen["q"] < 5 {
		select {
		case f := <-s.Video():
			seen[f.RID]++
			if seen[f.RID] > 1 && (f.Duration < 16*time.Millisecond || f.Duration > 17*time.Millisecond) {
				t.Fatalf("layer %s duration %s, want ~16.7ms from the PTS", f.RID, f.Duration)
			}
		case err := <-s.Err():
			t.Fatal(err)
		case <-deadline:
			t.Fatalf("frames: %v", seen)
		}
	}
	select {
	case a := <-s.Audio():
		if !bytes.Equal(a.Data, []byte{0xf8, 0xff, 0xfe}) || a.Duration != 20*time.Millisecond {
			t.Errorf("audio %+v", a)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no audio")
	}
	if err := s.RequestKeyframe("h"); err != nil {
		t.Fatal(err)
	}
	for key := false; !key; {
		select {
		case f := <-s.Video():
			key = f.RID == "h" && f.Keyframe
		case <-time.After(2 * time.Second):
			t.Fatal("no forced keyframe on h")
		}
	}
	if err := s.SetBitrate("q", 700); err != nil {
		t.Fatal(err)
	}
	if err := s.SetBitrate("x", 700); err == nil {
		t.Error("unknown layer accepted")
	}
	app, ok := s.(interface{ AudioApp() (AudioApp, bool) }).AudioApp()
	if !ok || app.PID != 4242 || audio.BrowserFamily(app.Binary, app.Name) != audio.BrowserChromium {
		t.Errorf("audio app %+v %v", app, ok)
	}
	// Drain until a thumbnail and stats came.
	for i := 0; i < 50; i++ {
		<-s.Video()
	}
	if _, ok := s.(interface{ Snapshot() ([]byte, bool) }).Snapshot(); !ok {
		t.Error("no thumbnail")
	}
	if cs := s.(interface{ CaptureStats() CaptureStats }).CaptureStats(); cs.Captured == 0 || cs.Width != 3440 {
		t.Errorf("capture stats %+v", cs)
	}
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	for range s.Video() {
	}

	lines := readFakeLog(t, logPath)
	var cfg sidecar.Config
	if err := json.Unmarshal(lines[0]["config"], &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Source != (sidecar.SourceRef{Kind: "display", ID: 1}) || len(cfg.Layers) != 3 || cfg.Layers[0].VBVMs != 250 ||
		cfg.Audio == nil || cfg.Audio.PID != 4242 || cfg.Thumbnail == nil || !cfg.Cursor || cfg.GOPSeconds != 10 {
		t.Errorf("config %+v", cfg)
	}
	var controls []string
	for _, l := range lines[1:] {
		if _, ok := l["stop"]; ok {
			controls = append(controls, "stop")
			continue
		}
		controls = append(controls, fmt.Sprintf("%s/%s/%s", l["type"], l["layer"], l["value"]))
	}
	if want := "[33/1/0 34/2/700 stop]"; fmt.Sprint(controls) != want {
		t.Errorf("controls %v, want %s", controls, want)
	}
}

func TestMacStreamWindowAudio(t *testing.T) {
	b, logPath := fakeBackend(t, "hidden", MacOptions{AudioApp: "window"})
	preset, _ := FindPreset("1080p60")
	layers, _ := preset.Layers([]string{"f"})
	s, err := b.Start(context.Background(), Source{ID: "window:7"}, Profile{Layers: layers, Audio: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Stop() }()
	go func() {
		for range s.Video() {
		}
	}()
	go func() {
		for range s.Audio() {
		}
	}()
	select {
	case ev := <-s.(interface{ Events() <-chan SourceEvent }).Events():
		if !ev.Paused || ev.PauseReason != protocol.PauseReasonSourceHidden {
			t.Errorf("event %+v", ev)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no hidden event")
	}
	_ = s.Stop()
	var cfg sidecar.Config
	_ = json.Unmarshal(readFakeLog(t, logPath)[0]["config"], &cfg)
	// A 1280x800 window: the 1080 layer keeps the window's 800 lines.
	if cfg.Source.Kind != "window" || cfg.Audio == nil || cfg.Audio.PID != 4242 || cfg.Layers[0].Width != 1280 || cfg.Layers[0].Height != 800 {
		t.Errorf("config %+v", cfg)
	}
}

// The curtain goes to the sidecar (black frames, muted audio there) and pauses the stream as
// on Linux: one event when it goes down, one when it lifts, and a hidden window meanwhile
// changes nothing (the curtain wins).
func TestMacStreamCurtain(t *testing.T) {
	b, logPath := fakeBackend(t, "ok", MacOptions{})
	preset, _ := FindPreset("1080p60")
	layers, _ := preset.Layers([]string{"f"})
	st, err := b.Start(context.Background(), Source{ID: "display:1"}, Profile{Layers: layers})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Stop() }()
	go func() {
		for range st.Video() {
		}
	}()
	s := st.(*macStream)
	next := func() SourceEvent {
		t.Helper()
		select {
		case ev := <-s.Events():
			return ev
		case <-time.After(2 * time.Second):
			t.Fatal("no event")
		}
		return SourceEvent{}
	}
	s.SetCurtain(true)
	if ev := next(); !ev.Paused || ev.PauseReason != protocol.PauseReasonPrivacyCurtain {
		t.Errorf("curtain on: %+v", ev)
	}
	if p, r := s.Paused(); !p || r != string(protocol.PauseReasonPrivacyCurtain) {
		t.Errorf("Paused() = %v, %s", p, r)
	}
	s.setPause(func(ps *pauseState) { ps.minimized = true })
	s.setPause(func(ps *pauseState) { ps.minimized = false })
	s.SetCurtain(false)
	if ev := next(); ev.Paused {
		t.Errorf("curtain off: %+v", ev)
	}
	if err := s.RequestKeyframe("f"); err != nil {
		t.Fatal(err)
	}
	_ = s.Stop()
	var controls []string
	for _, l := range readFakeLog(t, logPath)[1:] {
		if _, ok := l["stop"]; !ok {
			controls = append(controls, fmt.Sprintf("%s/%s", l["type"], l["value"]))
		}
	}
	// On, off, then the key frame after it: the IDR lands on the screen again.
	if want := "[37/1 37/0 33/0]"; fmt.Sprint(controls) != want {
		t.Errorf("controls %v, want %s", controls, want)
	}
}

func TestMacStreamEnded(t *testing.T) {
	b, _ := fakeBackend(t, "ended", MacOptions{})
	preset, _ := FindPreset("1080p60")
	layers, _ := preset.Layers([]string{"f"})
	s, err := b.Start(context.Background(), Source{ID: "display:1"}, Profile{Layers: layers})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Stop() }()
	if s.Audio() != nil {
		t.Error("audio channel without audio")
	}
	go func() {
		for range s.Video() {
		}
	}()
	select {
	case err := <-s.Err():
		if !errors.Is(err, ErrSourceEnded) {
			t.Errorf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no end")
	}
}

func TestMacStartErrors(t *testing.T) {
	preset, _ := FindPreset("1080p60")
	layers, _ := preset.Layers([]string{"f"})
	b, _ := fakeBackend(t, "permission", MacOptions{})
	// list fails first with the permission error.
	if _, err := b.Start(context.Background(), Source{ID: "display:1"}, Profile{Layers: layers}); !errors.Is(err, ErrScreenRecording) {
		t.Errorf("permission: %v", err)
	}
	b, _ = fakeBackend(t, "oldproto", MacOptions{})
	if _, err := b.Start(context.Background(), Source{ID: "display:1"}, Profile{Layers: layers}); err == nil || !strings.Contains(err.Error(), "protocol 99") {
		t.Errorf("old protocol: %v", err)
	}
	b, _ = fakeBackend(t, "ok", MacOptions{})
	if _, err := b.Start(context.Background(), Source{ID: "window:99"}, Profile{Layers: layers}); err == nil {
		t.Error("a window that is gone started")
	}
	if _, err := b.Start(context.Background(), Source{ID: "portal:screen"}, Profile{Layers: layers}); err == nil {
		t.Error("a portal id started")
	}
	if _, err := b.Start(context.Background(), Source{ID: "display:1"}, Profile{Layers: layers, Audio: true}); err == nil {
		t.Error("a display with audio and no app started")
	}
	b, _ = fakeBackend(t, "ok", MacOptions{AudioApp: "Nope"})
	if _, err := b.Start(context.Background(), Source{ID: "display:1"}, Profile{Layers: layers, Audio: true}); err == nil {
		t.Error("an unknown audio app started")
	}
	av1 := WithAV1(layers, AV1SavePercent)
	if _, err := b.Start(context.Background(), Source{ID: "display:1"}, Profile{Layers: av1}); err == nil {
		t.Error("AV1 layers accepted")
	}
}

func TestVideoToolboxResolve(t *testing.T) {
	if _, err := ParseEncoder("vt"); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveAV1(EncoderVideoToolbox, func(string) bool { return true }); err == nil || !strings.Contains(err.Error(), "macOS has no hardware AV1") {
		t.Errorf("ResolveAV1(vt) = %v", err)
	}
	if !VideoToolboxAvailable {
		if _, err := ResolveEncoder(EncoderVideoToolbox, func(string) bool { return true }); err == nil {
			t.Error("vt resolved outside macOS")
		}
	}
}
