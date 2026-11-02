// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package media

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/henriquefps/openlive/helper/internal/sidecar"
)

// The macOS backend: the Swift sidecar openlive-capture (helper/macos-capture)
// captures with ScreenCaptureKit and encodes with VideoToolbox; this side starts it, lists
// sources through it and turns its socket into a Stream. Nothing here needs macOS, so the
// tests run it against a fake sidecar on Linux; macos_darwin.go only says it is available.

// SidecarName is the sidecar's file name.
const SidecarName = "openlive-capture"

// EnvSidecar overrides where the sidecar is (development builds).
const EnvSidecar = "OPENLIVE_CAPTURE"

// ErrScreenRecording means macOS has not granted the Screen Recording permission.
var ErrScreenRecording = errors.New("macOS has not granted Screen Recording to the helper: System Settings > Privacy & Security > Screen & System Audio Recording, turn on openlive-helper, then start again")

// MacOptions configure the macOS backend.
type MacOptions struct {
	// Sidecar is the openlive-capture binary; empty finds it (FindSidecar).
	Sidecar string
	// AudioApp is whose audio a stream with audio captures: "window" for the shared window's
	// app, else an app's name or bundle id (as ListApps names them).
	AudioApp   string
	HideCursor bool
	// Animate shows the sidecar's moving test window, WxH, while capturing (development:
	// --test-pattern; capture the display it is on).
	Animate string
	// Thumbnails asks for a JPEG of the capture every 2 s (the stream card).
	Thumbnails bool
	Log        *slog.Logger
}

// MacBackend lists and captures through the sidecar.
type MacBackend struct {
	opts MacOptions
	bin  string
}

// SidecarBundle is the development app bundle around the sidecar (macos-capture/bundle.sh):
// UserNotifications only works in a process with a bundle identity.
const SidecarBundle = "OpenliveHelper.app"

// FindSidecar looks for openlive-capture: $OPENLIVE_CAPTURE, in the development bundle next to
// the helper's binary, next to the binary itself (also Contents/MacOS in the app bundle), then
// in an app bundle's Helpers or Resources folder.
func FindSidecar() (string, error) {
	if p := os.Getenv(EnvSidecar); p != "" {
		return p, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	dir := filepath.Dir(exe)
	for _, p := range []string{
		filepath.Join(dir, SidecarBundle, "Contents", "MacOS", SidecarName),
		filepath.Join(dir, SidecarName),
		filepath.Join(dir, "..", "Helpers", SidecarName),
		filepath.Join(dir, "..", "Resources", SidecarName),
	} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("%w: %s not found next to the helper (set %s, or build helper/macos-capture)", ErrUnavailable, SidecarName, EnvSidecar)
}

// NewMacBackend finds the sidecar.
func NewMacBackend(opts MacOptions) (*MacBackend, error) {
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	bin := opts.Sidecar
	if bin == "" {
		var err error
		if bin, err = FindSidecar(); err != nil {
			return nil, err
		}
	}
	return &MacBackend{opts: opts, bin: bin}, nil
}

// Sidecar is the binary in use.
func (b *MacBackend) Sidecar() string { return b.bin }

// MacDisplay, MacWindow and MacSources are the sidecar's list output.
type MacDisplay struct {
	ID        uint32  `json:"id"`
	Name      string  `json:"name"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	RefreshHz float64 `json:"refreshHz"`
	Main      bool    `json:"main"`
}

type MacWindow struct {
	ID       uint32 `json:"id"`
	Title    string `json:"title"`
	App      string `json:"app"`
	BundleID string `json:"bundleId"`
	PID      int    `json:"pid"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

type MacSources struct {
	Displays []MacDisplay      `json:"displays"`
	Windows  []MacWindow       `json:"windows"`
	Apps     []sidecar.AppInfo `json:"apps"`
}

// run runs a one-shot sidecar command and returns its stdout. A permission error is
// ErrScreenRecording.
func (b *MacBackend) run(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, b.bin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if strings.Contains(msg, "Screen Recording permission") {
			return nil, ErrScreenRecording
		}
		return nil, fmt.Errorf("%s %s: %w: %s", SidecarName, args[0], err, msg)
	}
	return out, nil
}

// Sources lists the displays, the windows on screen and the running apps (in the Dock).
func (b *MacBackend) Sources(ctx context.Context) (MacSources, error) {
	out, err := b.run(ctx, "list")
	if err != nil {
		return MacSources{}, err
	}
	var s MacSources
	if err := json.Unmarshal(out, &s); err != nil {
		return MacSources{}, fmt.Errorf("%s list: %w", SidecarName, err)
	}
	return s, nil
}

// MacDisplayID and MacWindowID are the Source IDs of a display and a window.
func MacDisplayID(id uint32) string { return "display:" + strconv.FormatUint(uint64(id), 10) }
func MacWindowID(id uint32) string  { return "window:" + strconv.FormatUint(uint64(id), 10) }

// parseMacID reads a Source ID back.
func parseMacID(id string) (sidecar.SourceRef, error) {
	kind, n, ok := strings.Cut(id, ":")
	v, err := strconv.ParseUint(n, 10, 32)
	if !ok || err != nil || (kind != "display" && kind != "window") {
		return sidecar.SourceRef{}, fmt.Errorf("not a macOS source id: %q", id)
	}
	return sidecar.SourceRef{Kind: kind, ID: uint32(v)}, nil
}

// MacSourceList turns the sidecar's list into Sources: every display, then every window
// (whose app's audio can go with it).
func MacSourceList(s MacSources) []Source {
	var out []Source
	for _, d := range s.Displays {
		out = append(out, Source{ID: MacDisplayID(d.ID), Kind: SourceScreen, Label: fmt.Sprintf("%s (%dx%d)", d.Name, d.Width, d.Height), Width: d.Width, Height: d.Height})
	}
	for _, w := range s.Windows {
		label := w.App
		if w.Title != "" && w.Title != w.App {
			label = w.App + " – " + w.Title
		}
		out = append(out, Source{ID: MacWindowID(w.ID), Kind: SourceWindow, Label: label, AppName: w.App, Width: w.Width, Height: w.Height, HasAudio: true})
	}
	return out
}

// ListSources lists the displays and windows.
func (b *MacBackend) ListSources(ctx context.Context) ([]Source, error) {
	s, err := b.Sources(ctx)
	if err != nil {
		return nil, err
	}
	return MacSourceList(s), nil
}

// Thumbnail grabs a still of a source (macOS 14 and later).
func (b *MacBackend) Thumbnail(ctx context.Context, src Source, maxWidth, maxHeight int) (Thumbnail, error) {
	if _, err := parseMacID(src.ID); err != nil {
		return Thumbnail{}, err
	}
	out, err := b.run(ctx, "thumbnail", "--source", src.ID, "--max", fmt.Sprintf("%dx%d", maxWidth, maxHeight))
	if err != nil {
		return Thumbnail{}, err
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		return Thumbnail{}, fmt.Errorf("%s thumbnail: %w", SidecarName, err)
	}
	return Thumbnail{MimeType: "image/jpeg", Width: cfg.Width, Height: cfg.Height, Data: out}, nil
}

// FindApp finds an app by name or bundle id, ignoring case.
func FindApp(apps []sidecar.AppInfo, name string) (sidecar.AppInfo, bool) {
	for _, a := range apps {
		if strings.EqualFold(a.Name, name) || strings.EqualFold(a.BundleID, name) {
			return a, true
		}
	}
	return sidecar.AppInfo{}, false
}

// MacDoctor is the sidecar's doctor report.
type MacDoctor struct {
	MacOS           string `json:"macOS"`
	ScreenRecording bool   `json:"screenRecording"`
	Encoders        []struct {
		Name     string `json:"name"`
		Codec    string `json:"codec"`
		Hardware bool   `json:"hardware"`
	} `json:"encoders"`
	H264Hardware    bool   `json:"h264Hardware"`
	HEVCHardware    bool   `json:"hevcHardware"`
	AV1Hardware     bool   `json:"av1Hardware"`
	LowLatencyH264  bool   `json:"lowLatencyH264"`
	LowLatencyError string `json:"lowLatencyError"`
}

// Doctor runs the sidecar's checks.
func (b *MacBackend) Doctor(ctx context.Context) (MacDoctor, error) {
	out, err := b.run(ctx, "doctor")
	if err != nil {
		return MacDoctor{}, err
	}
	var d MacDoctor
	if err := json.Unmarshal(out, &d); err != nil {
		return MacDoctor{}, fmt.Errorf("%s doctor: %w", SidecarName, err)
	}
	return d, nil
}

// MinMacOS is the oldest macOS the sidecar runs on (ScreenCaptureKit's per-app audio, the
// low-latency H.264 encoder): 13.
const MinMacOS = 13

// Start captures src: the layers keep their preset heights and take the source's aspect
// ratio (FitLayers), and run no faster than the display (CapFPS). The sidecar encodes every
// layer from one capture.
func (b *MacBackend) Start(ctx context.Context, src Source, p Profile) (Stream, error) {
	ref, err := parseMacID(src.ID)
	if err != nil {
		return nil, err
	}
	var h264 []Layer
	for _, l := range p.Layers {
		if l.IsAV1() {
			return nil, fmt.Errorf("layer %s: macOS has no hardware AV1 encoder", l.RID)
		}
		h264 = append(h264, l)
	}
	if len(h264) == 0 {
		return nil, errors.New("no layers")
	}
	srcs, err := b.Sources(ctx)
	if err != nil {
		return nil, err
	}
	w, h, hz, win, err := locate(srcs, ref)
	if err != nil {
		return nil, err
	}
	layers := FitLayers(h264, w, h)
	if capped, changed := CapFPS(layers, hz); changed {
		b.opts.Log.Info("the display is slower than the preset: capturing at its rate", "hz", hz)
		layers = capped
	}
	cfg := sidecar.Config{Source: ref, GOPSeconds: p.GOP.Seconds(), Cursor: !b.opts.HideCursor}
	if cfg.GOPSeconds <= 0 {
		cfg.GOPSeconds = 10
	}
	for _, l := range layers {
		cfg.Layers = append(cfg.Layers, sidecar.LayerConfig{RID: l.RID, Width: l.Width, Height: l.Height, FPS: l.FPS, Kbps: l.Kbps, VBVMs: l.vbvMillis()})
	}
	if p.Audio {
		a, err := b.audioConfig(srcs, win)
		if err != nil {
			return nil, err
		}
		cfg.Audio = a
	}
	if b.opts.Thumbnails {
		cfg.Thumbnail = &sidecar.ThumbnailConfig{Width: thumbWidth, EveryMs: 2000}
	}
	args := []string{"capture", "--fd", "3"}
	if b.opts.Animate != "" {
		args = append(args, "--animate", b.opts.Animate)
	}
	return startSidecar(ctx, b.bin, args, cfg, layers, p.Audio, b.opts.Log)
}

// locate finds a source's pixel size, its display's refresh rate and, for a window, the window.
func locate(s MacSources, ref sidecar.SourceRef) (w, h int, hz float64, win *MacWindow, err error) {
	mainHz := 0.0
	for _, d := range s.Displays {
		if d.Main || mainHz == 0 {
			mainHz = d.RefreshHz
		}
		if ref.Kind == "display" && d.ID == ref.ID {
			return d.Width, d.Height, d.RefreshHz, nil, nil
		}
	}
	if ref.Kind == "window" {
		for i := range s.Windows {
			if s.Windows[i].ID == ref.ID {
				win := s.Windows[i]
				return win.Width, win.Height, mainHz, &win, nil
			}
		}
	}
	return 0, 0, 0, nil, fmt.Errorf("%s %d is not shared any more (closed, or off screen)", ref.Kind, ref.ID)
}

// audioConfig is whose audio goes with the capture: the window's app for "window", else the
// app named. One app only, so a browser in an Openlive voice channel is never captured unless
// it is the app chosen; the browser warning covers that case.
func (b *MacBackend) audioConfig(s MacSources, win *MacWindow) (*sidecar.AudioConfig, error) {
	switch b.opts.AudioApp {
	case "":
		if win == nil {
			return nil, errors.New("audio: sharing a whole display needs the app to take the sound from (--audio-app <name>)")
		}
		fallthrough
	case "window":
		if win == nil {
			return nil, errors.New("audio: --audio-app window needs a window source")
		}
		return &sidecar.AudioConfig{PID: win.PID, BundleID: win.BundleID}, nil
	}
	app, ok := FindApp(s.Apps, b.opts.AudioApp)
	if !ok {
		return nil, fmt.Errorf("audio: no running app %q (see --list-audio-apps)", b.opts.AudioApp)
	}
	return &sidecar.AudioConfig{PID: app.PID, BundleID: app.BundleID}, nil
}

// startTimeout bounds the sidecar's hello and the capture's start.
var startTimeout = 20 * time.Second

// startSidecar runs bin with one end of a socketpair as fd 3, sends the config and waits for
// the capture to start.
func startSidecar(ctx context.Context, bin string, args []string, cfg sidecar.Config, layers []Layer, audio bool, log *slog.Logger) (*macStream, error) {
	conn, cmd, logR, err := sidecar.Spawn(bin, args...)
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", SidecarName, err)
	}
	s := newMacStream(conn, cmd, layers, audio, log)
	go s.logStderr(logR)
	if err := s.handshake(ctx, cfg); err != nil {
		_ = s.Stop()
		return nil, err
	}
	s.looping = true
	go s.readLoop()
	return s, nil
}

// macStream is a running sidecar capture.
type macStream struct {
	conn   net.Conn
	cmd    *exec.Cmd
	layers []Layer
	log    *slog.Logger

	wmu sync.Mutex // serializes writes to conn

	video, audio chan EncodedFrame
	errs         chan error
	events       chan SourceEvent
	done         chan struct{}
	loopDone     chan struct{}
	exited       chan struct{}
	stopOnce     sync.Once
	// looping is set before readLoop starts (Stop then waits for it to end).
	looping bool

	// pause combines the curtain and a hidden window, as on Linux (pauseState).
	pauseMu sync.Mutex
	pause   pauseState
	paused  bool

	mu       sync.Mutex
	started  sidecar.Started
	stats    CaptureStats
	last     sidecar.Stats
	thumb    []byte
	audioApp *sidecar.AppInfo
}

func newMacStream(conn net.Conn, cmd *exec.Cmd, layers []Layer, audio bool, log *slog.Logger) *macStream {
	s := &macStream{
		conn: conn, cmd: cmd, layers: layers, log: log,
		video:    make(chan EncodedFrame, 64),
		errs:     make(chan error, 1),
		events:   make(chan SourceEvent, 8),
		done:     make(chan struct{}),
		loopDone: make(chan struct{}),
		exited:   make(chan struct{}),
	}
	if audio {
		s.audio = make(chan EncodedFrame, 64)
	}
	go func() {
		_ = cmd.Wait()
		close(s.exited)
	}()
	return s
}

// logStderr copies the sidecar's log lines into the helper's log.
func (s *macStream) logStderr(r io.ReadCloser) {
	defer func() { _ = r.Close() }()
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		s.log.Info("capture sidecar", "msg", strings.TrimPrefix(sc.Text(), SidecarName+": "))
	}
}

func (s *macStream) handshake(ctx context.Context, cfg sidecar.Config) error {
	deadline := time.Now().Add(startTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = s.conn.SetReadDeadline(deadline)
	defer func() { _ = s.conn.SetReadDeadline(time.Time{}) }()
	m, err := sidecar.Read(s.conn)
	if err != nil {
		return fmt.Errorf("%s did not say hello: %w", SidecarName, err)
	}
	var hello sidecar.Hello
	if m.Type != sidecar.TypeHello || m.Decode(&hello) != nil {
		return fmt.Errorf("%s: expected hello, got message 0x%02x", SidecarName, byte(m.Type))
	}
	if hello.ProtocolVersion != sidecar.ProtocolVersion {
		return fmt.Errorf("%s %s speaks protocol %d, this helper %d: rebuild them together", SidecarName, hello.Version, hello.ProtocolVersion, sidecar.ProtocolVersion)
	}
	s.log.Debug("capture sidecar", "version", hello.Version, "os", hello.OS)
	if err := s.write(sidecar.TypeConfig, cfg); err != nil {
		return err
	}
	for {
		m, err := sidecar.Read(s.conn)
		if err != nil {
			return fmt.Errorf("%s: capture did not start: %w", SidecarName, err)
		}
		switch m.Type {
		case sidecar.TypeStarted:
			var st sidecar.Started
			if err := m.Decode(&st); err != nil {
				return err
			}
			s.mu.Lock()
			s.started, s.audioApp = st, st.AudioApp
			s.stats.Width, s.stats.Height = st.Width, st.Height
			if st.AudioApp != nil {
				s.stats.AudioLinked = 1
			}
			s.mu.Unlock()
			s.log.Info("capture sidecar started", "size", fmt.Sprintf("%dx%d", st.Width, st.Height), "encoder", st.Encoder)
			return nil
		case sidecar.TypeError:
			var e sidecar.Error
			if err := m.Decode(&e); err != nil {
				return err
			}
			if e.Code == "permission" {
				return ErrScreenRecording
			}
			if e.Fatal {
				return &e
			}
			s.log.Warn("capture sidecar", "code", e.Code, "err", e.Message)
		default:
			// Frames may race the started message; anything else before it is dropped.
		}
	}
}

func (s *macStream) write(t sidecar.Type, v any) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	switch p := v.(type) {
	case []byte:
		return sidecar.Write(s.conn, t, p)
	case nil:
		return sidecar.Write(s.conn, t, nil)
	default:
		return sidecar.WriteJSON(s.conn, t, v)
	}
}

func (s *macStream) fail(err error) {
	select {
	case s.errs <- err:
	default:
	}
}

func (s *macStream) stopped() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

// readLoop turns the sidecar's messages into frames, events and stats until it exits.
func (s *macStream) readLoop() {
	defer close(s.loopDone)
	for {
		m, err := sidecar.Read(s.conn)
		if err != nil {
			if !s.stopped() {
				s.fail(fmt.Errorf("%s exited: %w", SidecarName, err))
			}
			return
		}
		switch m.Type {
		case sidecar.TypeVideo:
			v, err := sidecar.ParseVideo(m.Payload)
			if err != nil || v.Layer >= len(s.layers) {
				continue
			}
			if !s.send(s.video, s.videoFrame(v)) {
				return
			}
		case sidecar.TypeAudio:
			a, err := sidecar.ParseAudio(m.Payload)
			if err != nil || s.audio == nil {
				continue
			}
			f := EncodedFrame{Data: a.Data, PTS: time.Duration(a.PTSNanos), Duration: time.Duration(a.DurationMicros) * time.Microsecond}
			if !s.send(s.audio, f) {
				return
			}
		case sidecar.TypeStats:
			var st sidecar.Stats
			if m.Decode(&st) == nil {
				s.mu.Lock()
				s.last = st
				s.stats.Captured += uint64(st.Captured)
				s.mu.Unlock()
				var skipped []string
				for _, l := range st.Layers {
					if l.Dropped > 0 || l.Busy > 0 {
						skipped = append(skipped, fmt.Sprintf("%s=%d/%d", l.RID, l.Dropped, l.Busy))
					}
				}
				s.log.Debug("capture sidecar stats", "captured", st.Captured, "idle", st.Idle, "repeated", st.Repeated, "dropped", st.Dropped,
					"encoderDroppedBusy", strings.Join(skipped, " "), "delayMs", fmt.Sprintf("%.1f", st.CaptureDelayMsAvg), "cpu", fmt.Sprintf("%.0f%%", st.CPUPercent))
			}
		case sidecar.TypeThumbnail:
			s.mu.Lock()
			s.thumb = m.Payload
			s.mu.Unlock()
		case sidecar.TypeEvent:
			var e sidecar.Event
			if m.Decode(&e) != nil {
				continue
			}
			switch e.Event {
			case "ended":
				s.fail(ErrSourceEnded)
			case "hidden", "shown":
				s.setPause(func(ps *pauseState) { ps.minimized = e.Event == "hidden" })
			}
		case sidecar.TypeError:
			var e sidecar.Error
			if m.Decode(&e) != nil {
				continue
			}
			if e.Fatal {
				s.fail(&e)
				continue
			}
			s.log.Warn("capture sidecar", "code", e.Code, "err", e.Message)
		}
	}
}

// videoFrame turns a sidecar frame into an EncodedFrame. ScreenCaptureKit sends nothing for
// a still screen, so frames are not evenly spaced: Duration is only the nominal 1/fps, and
// the publisher spaces the RTP timestamps by the PTS and the wall clock (FrameClock).
func (s *macStream) videoFrame(v sidecar.Video) EncodedFrame {
	l := s.layers[v.Layer]
	d := time.Second / time.Duration(max(1, l.FPS))
	return EncodedFrame{RID: l.RID, Data: v.Data, Keyframe: v.Keyframe, PTS: time.Duration(v.PTSNanos), Duration: d}
}

// send blocks until out takes f (back-pressure reaches the sidecar, which then drops raw
// frames) or the stream stops.
func (s *macStream) send(out chan<- EncodedFrame, f EncodedFrame) bool {
	select {
	case out <- f:
		return true
	case <-s.done:
		return false
	}
}

func (s *macStream) Video() <-chan EncodedFrame { return s.video }

func (s *macStream) Audio() <-chan EncodedFrame {
	if s.audio == nil {
		return nil
	}
	return s.audio
}

func (s *macStream) Err() <-chan error { return s.errs }

// Events are the pause changes: the shared window's hide and show (a minimized window
// pauses the stream) and the curtain.
func (s *macStream) Events() <-chan SourceEvent { return s.events }

// SetCurtain turns the privacy curtain on or off, as on Linux: the sidecar encodes a black
// frame instead of the screen and mutes the app audio, so the encoders and the tracks keep
// running, and the stream reports itself paused. Lifting it does not ask for key frames;
// the caller does, after this (gatedStream.SetPaused), so they land on the screen again.
func (s *macStream) SetCurtain(on bool) {
	if err := s.write(sidecar.TypeCurtain, sidecar.CurtainPayload(on)); err != nil {
		s.log.Warn("capture sidecar: curtain", "on", on, "err", err)
	}
	s.setPause(func(ps *pauseState) { ps.curtain = on })
}

// Paused is the current pause state.
func (s *macStream) Paused() (bool, string) {
	s.pauseMu.Lock()
	defer s.pauseMu.Unlock()
	p, r := s.pause.paused()
	return p, string(r)
}

// setPause changes one reason for "paused" and reports a change of the combined state.
func (s *macStream) setPause(change func(*pauseState)) {
	s.pauseMu.Lock()
	change(&s.pause)
	paused, reason := s.pause.paused()
	changed := paused != s.paused
	s.paused = paused
	s.pauseMu.Unlock()
	if !changed {
		return
	}
	select {
	case s.events <- SourceEvent{Paused: paused, PauseReason: reason}:
	default:
		s.log.Warn("source event dropped (nobody reading)", "paused", paused)
	}
}

func (s *macStream) layerIndex(rid string) (int, error) {
	i := slices.IndexFunc(s.layers, func(l Layer) bool { return l.RID == rid })
	if i < 0 {
		return 0, fmt.Errorf("no layer %q", rid)
	}
	return i, nil
}

// SetBitrate changes one layer's bitrate in place. VideoToolbox emits no IDR for it; the
// data-rate window stays the same (the fixed VBV as time).
func (s *macStream) SetBitrate(rid string, kbps int) error {
	i, err := s.layerIndex(rid)
	if err != nil {
		return err
	}
	if kbps <= 0 {
		return errors.New("bitrate must be positive")
	}
	return s.write(sidecar.TypeBitrate, sidecar.BitratePayload(i, kbps))
}

// RequestKeyframe asks one layer for an IDR (on a still screen the sidecar encodes the last
// frame again at once to carry it).
func (s *macStream) RequestKeyframe(rid string) error {
	i, err := s.layerIndex(rid)
	if err != nil {
		return err
	}
	return s.write(sidecar.TypeKeyframe, sidecar.KeyframePayload(i))
}

// Layers are the layers as fitted to the source.
func (s *macStream) Layers() []Layer { return slices.Clone(s.layers) }

// Encoder is VideoToolbox.
func (s *macStream) Encoder() Encoder { return EncoderVideoToolbox }

// EncoderName is VideoToolbox's own name for the encoder in use.
func (s *macStream) EncoderName() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started.Encoder
}

// AudioApp is the app whose audio the stream carries: its name and bundle id, which the
// browser check reads.
func (s *macStream) AudioApp() (AudioApp, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.audioApp == nil {
		return AudioApp{}, false
	}
	return AudioApp{Name: s.audioApp.Name, Binary: s.audioApp.BundleID, PID: s.audioApp.PID}, true
}

// CaptureStats count the frames with new content.
func (s *macStream) CaptureStats() CaptureStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stats
}

// SidecarStats are the sidecar's numbers for the last second.
func (s *macStream) SidecarStats() sidecar.Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}

// Snapshot is the newest thumbnail JPEG, once.
func (s *macStream) Snapshot() ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.thumb
	s.thumb = nil
	return t, t != nil
}

// Stop asks the sidecar to stop, waits up to 3 s for it to exit (then kills it) and closes
// the channels.
func (s *macStream) Stop() error {
	s.stopOnce.Do(func() {
		close(s.done)
		_ = s.write(sidecar.TypeStop, nil)
		select {
		case <-s.exited:
		case <-time.After(3 * time.Second):
			_ = s.cmd.Process.Kill()
			<-s.exited
		}
		_ = s.conn.Close()
		if s.looping {
			<-s.loopDone
		}
		close(s.video)
		if s.audio != nil {
			close(s.audio)
		}
		close(s.errs)
	})
	return nil
}
