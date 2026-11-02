// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux && !nogst

package media

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-gst/go-gst/pkg/gst"

	"github.com/henriquefps/openlive/helper/internal/audio"
	"github.com/henriquefps/openlive/helper/internal/compositor"
	"github.com/henriquefps/openlive/helper/internal/overlay"
	"github.com/henriquefps/openlive/helper/internal/portal"
)

// LinuxAvailable is true in builds with the Linux capture backend.
const LinuxAvailable = true

// LinuxOptions configure the Linux backend.
type LinuxOptions struct {
	// Store keeps the portal restore token and the chosen source.
	Store portal.Store
	// Pick ignores the saved token, so the system dialog asks again.
	Pick bool
	// WindowHint (a caption or app substring) tells windows of the same size apart when
	// finding the shared window in KWin.
	WindowHint string
	// AudioApp is the app whose audio is captured: a name from `pw-dump`
	// (application.name, binary or node.name), or "window" for the shared window's app.
	AudioApp string
	// StillPause turns on the "content unchanged for N s" paused fallback (0: off).
	StillPause time.Duration
	Path       CapturePath
	HideCursor bool
	// TestPattern replaces the portal with gltestsrc/videotestsrc of TestWidth x
	// TestHeight (development and integration tests).
	TestPattern           string
	TestWidth, TestHeight int
	// StartAudio starts the per-app capture (default audio.StartPW).
	StartAudio audio.Starter
	Log        *slog.Logger
}

// LinuxBackend captures a monitor or a window through the ScreenCast portal and
// PipeWire, scales on the GPU and encodes with NVENC (or x264), plus one app's audio.
type LinuxBackend struct {
	opts LinuxOptions
}

// NewLinuxBackend returns the backend.
func NewLinuxBackend(opts LinuxOptions) (*LinuxBackend, error) {
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	if opts.StartAudio == nil {
		opts.StartAudio = audio.StartPW
	}
	if opts.Path == "" {
		opts.Path = PathAuto
	}
	return &LinuxBackend{opts: opts}, nil
}

// ListSources lists what can be shared. The portal picks the actual monitor or window
// in the system's own dialog, so these are the two kinds (the portal pseudo-sources of
// source.go), plus the last choices it can restore (PortalSources).
func (b *LinuxBackend) ListSources(context.Context) ([]Source, error) {
	return PortalSources(b.opts.Store), nil
}

// errRestoreMismatch: the portal restored something other than what was chosen.
type errRestoreMismatch struct{ reason string }

func (e *errRestoreMismatch) Error() string {
	return "the restored source is not the chosen one: " + e.reason
}

// Start opens the portal, and starts capture and encoding. It returns after the first
// frame. The pickers (PortalScreenID, PortalWindowID) always show the system dialog; any
// other source restores the saved choice when it can (the "Last" sources, and the CLI
// without --pick), and what was restored is checked against that choice.
func (b *LinuxBackend) Start(ctx context.Context, src Source, p Profile) (Stream, error) {
	initGst()
	log := b.opts.Log
	enc, err := ResolveEncoder(p.Encoder, HasElement)
	if err != nil {
		return nil, err
	}
	if HasAV1(p.Layers) {
		if _, err := ResolveAV1(enc, HasElement); err != nil {
			return nil, err
		}
	}
	path := ResolveCapturePath(b.opts.Path, enc, HasElement)
	if path == PathCPU || enc == EncoderX264 {
		log.Warn("software path: measurements showed that the CPU path does not hold 1080p60", "capturePath", path, "encoder", enc)
	}
	if b.opts.TestPattern != "" {
		return b.startTest(ctx, p, enc, path)
	}
	var kind portal.Kind
	switch src.Kind {
	case SourceScreen:
		kind = portal.KindMonitor
	case SourceWindow:
		kind = portal.KindWindow
	default:
		return nil, fmt.Errorf("the Linux backend cannot capture a %q source", src.Kind)
	}

	kctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	kw, err := compositor.WatchKWin(kctx)
	cancel()
	if err != nil {
		lvl := log.Warn
		if errors.Is(err, compositor.ErrUnsupported) {
			lvl = log.Info
		}
		lvl("no compositor queries: output names, window matching and the minimized pause are off", "err", err)
		kw = nil
	}
	forceDialog := !restores(src, b.opts.Pick)
	for attempt := 0; ; attempt++ {
		s, err := b.startPortal(ctx, kind, p, enc, path, kw, forceDialog)
		var mm *errRestoreMismatch
		if errors.As(err, &mm) && attempt == 0 {
			log.Warn("the portal restored a different source; asking again", "reason", mm.reason)
			_ = b.opts.Store.Forget(kind)
			forceDialog = true
			continue
		}
		if err != nil {
			if kw != nil {
				kw.Close()
			}
			return nil, err
		}
		return s, nil
	}
}

func (b *LinuxBackend) startPortal(ctx context.Context, kind portal.Kind, p Profile, enc Encoder, path CapturePath, kw *compositor.KWin, forceDialog bool) (*LinuxStream, error) {
	log := b.opts.Log
	rec, err := b.opts.Store.Load(kind)
	if err != nil {
		log.Warn("restore token", "err", err)
	}
	token := rec.Token
	if forceDialog {
		token = ""
	}
	if token == "" {
		log.Info("the system will ask which " + kind.String() + " to share")
	}
	sess, err := portal.Open(ctx, portal.Options{Kind: kind, RestoreToken: token, HideCursor: b.opts.HideCursor, StartTimeout: 5 * time.Minute})
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			sess.Close()
		}
	}()
	// The token rotates on every Start: save the new one at once.
	if err := b.opts.Store.SaveToken(kind, sess.RestoreToken, time.Now()); err != nil {
		log.Warn("save restore token", "err", err)
	}
	st := sess.Streams[0]
	log.Info("portal started", "kind", kind, "restored", sess.Restored, "startTook", sess.StartTook.Round(time.Millisecond),
		"node", st.NodeID, "serial", st.Serial, "size", fmt.Sprintf("%dx%d", st.Width, st.Height),
		"position", fmt.Sprintf("%d,%d", st.X, st.Y), "newToken", sess.RestoreToken != "")

	// Windows use shared-memory frames: with DMA-BUFs, a capture branch restarted after a
	// resize negotiated the new size and then got no frame (KWin 6.8, this task's run);
	// The window runs that worked read shared memory. Monitors keep DMA-BUFs.
	spec := sourceSpec{serial: st.Serial, fps: p.Layers[0].FPS, shm: kind == portal.KindWindow}
	if spec.serial == 0 {
		spec.serial = uint64(st.NodeID)
	}
	// The frame size: the portal's for a monitor, a short probe for a window (the portal
	// reports 0x0 for a restored window, and a window's size is its own).
	w, h := st.Width, st.Height
	if kind == portal.KindWindow || w <= 0 || h <= 0 {
		pw, ph, err := probeSize(sess, spec, 10*time.Second)
		if err != nil {
			return nil, err
		}
		w, h = pw, ph
	}
	choice := portal.Choice{Kind: kind, X: st.X, Y: st.Y, Width: w, Height: h}
	// The size the layers are fitted to: a monitor's pixels (see MonitorPixelSize). The
	// saved choice keeps the portal's size, which is what a restored session reports.
	capW, capH := w, h
	monitorKnown := false
	var window compositor.Window
	if kw != nil {
		snap := kw.Snapshot()
		switch kind {
		case portal.KindMonitor:
			if o, found := compositor.MatchOutput(snap.Outputs, st.X, st.Y, st.HasPosition, st.Width, st.Height); found {
				choice.Output = o.Name
				capW, capH = MonitorPixelSize(w, h, o.Width, o.Height, o.Scale)
				monitorKnown = true
				if capW != w || capH != h {
					log.Info("scaled output: capturing its pixels", "output", o.Name, "scale", o.Scale,
						"logical", fmt.Sprintf("%dx%d", w, h), "pixels", fmt.Sprintf("%dx%d", capW, capH))
				}
			}
		case portal.KindWindow:
			if win, found := compositor.MatchWindow(snap.Windows, w, h, b.opts.WindowHint); found {
				window = win
				choice.WindowClass, choice.WindowCaption = win.Class, win.Caption
			} else if app, found := compositor.MatchApp(snap.Windows, w, h); found {
				// Several windows of one app: its audio and name are known, the window is not.
				window = app
				choice.WindowClass = app.Class
				log.Warn("several windows of this app have this size; the minimized pause is off. "+
					"Pass --window-hint with part of its title to fix this", "app", app.Class, "size", fmt.Sprintf("%dx%d", w, h))
			} else {
				log.Warn("could not tell which window is shared (several windows of this size?); the minimized pause is off. "+
					"Pass --window-hint with part of its title to fix this", "size", fmt.Sprintf("%dx%d", w, h))
			}
		}
	}
	// A preset faster than the monitor captures at the monitor's rate.
	output := choice.Output
	if kind == portal.KindWindow {
		output = window.Output
	}
	if hz := refreshRate(ctx, output); hz > 0 {
		if capped, changed := CapFPS(p.Layers, hz); changed {
			log.Warn("the monitor refreshes slower than the preset: capturing at its rate",
				"output", output, "refreshHz", math.Round(hz*100)/100, "presetFps", p.Layers[0].FPS, "fps", capped[0].FPS)
			p.Layers = capped
			spec.fps = capped[0].FPS
		}
	}
	if sess.Restored && rec.Choice.Kind == kind {
		if match, why := rec.Choice.Matches(choice); !match {
			return nil, &errRestoreMismatch{reason: why}
		}
	}
	if err := b.opts.Store.Save(kind, portal.Record{Token: sess.RestoreToken, Choice: choice, SavedAt: time.Now()}); err != nil {
		log.Warn("save restore record", "err", err)
	}

	if kind == portal.KindMonitor && !monitorKnown {
		// No compositor to ask for the output's scale: read the frame size itself.
		if pw, ph, err := probeSize(sess, spec, 10*time.Second); err == nil {
			capW, capH = pw, ph
		} else {
			log.Warn("could not read the monitor's frame size; using the portal's", "err", err)
		}
	}
	s, err := b.build(ctx, p, enc, path, spec, capW, capH, choice)
	if err != nil {
		return nil, err
	}
	s.session, s.kwin, s.windowID = sess, kw, window.ID
	s.onStop = append(s.onStop, sess.Close)
	if kw != nil {
		s.onStop = append(s.onStop, kw.Close)
		if window.ID != "" {
			s.setPause(func(ps *pauseState) { ps.minimized = window.Minimized })
		}
	}
	if err := s.run(ctx); err != nil {
		_ = s.Stop()
		ok = true // Stop closed the session
		return nil, err
	}
	if p.Audio {
		s.startAudio(ctx, window)
	}
	ok = true
	return s, nil
}

func (b *LinuxBackend) startTest(ctx context.Context, p Profile, enc Encoder, path CapturePath) (Stream, error) {
	w, h := b.opts.TestWidth, b.opts.TestHeight
	if w <= 0 || h <= 0 {
		w, h = p.Layers[0].Width, p.Layers[0].Height
	}
	spec := sourceSpec{testPattern: b.opts.TestPattern, width: w, height: h, fps: p.Layers[0].FPS}
	s, err := b.build(ctx, p, enc, path, spec, w, h, portal.Choice{Kind: portal.KindMonitor, Output: "test pattern", Width: w, Height: h})
	if err != nil {
		return nil, err
	}
	if err := s.run(ctx); err != nil {
		_ = s.Stop()
		return nil, err
	}
	if p.Audio {
		s.startAudio(ctx, compositor.Window{})
	}
	return s, nil
}

// probeSize reads the stream's frame size with a throwaway pipewiresrc → fakesink. A
// fresh pipewiresrc on the same node starts at full rate afterwards.
func probeSize(sess *portal.Session, spec sourceSpec, timeout time.Duration) (int, int, error) {
	remote, err := sess.OpenPipeWireRemote()
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = remote.Close() }()
	desc := fmt.Sprintf("pipewiresrc name=probe fd=%d target-object=%d ! video/x-raw,format=BGRx,max-framerate=%d/1 ! fakesink name=sink sync=false",
		remote.Fd(), spec.serial, spec.fps)
	pipeline, err := parsePipeline(desc)
	if err != nil {
		return 0, 0, err
	}
	defer pipeline.SetState(gst.StateNull)
	type size struct{ w, h int }
	got := make(chan size, 1)
	pipeline.GetByName("sink").GetStaticPad("sink").AddProbe(gst.PadProbeTypeEventDownstream, func(_ gst.Pad, info *gst.PadProbeInfo) gst.PadProbeReturn {
		if w, h, ok := capsSize(info); ok {
			select {
			case got <- size{w, h}:
			default:
			}
		}
		return gst.PadProbeOK
	})
	if err := play(pipeline); err != nil {
		return 0, 0, err
	}
	bus := pipeline.GetBus()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case s := <-got:
			return s.w, s.h, nil
		default:
		}
		if msg := bus.TimedPop(gst.ClockTime(50 * time.Millisecond)); msg != nil && msg.Type() == gst.MessageError {
			err := gstError(msg)
			if isSourceEndedMessage(err.Error()) {
				return 0, 0, ErrSourceEnded
			}
			return 0, 0, fmt.Errorf("probe the source size: %w", err)
		}
	}
	return 0, 0, fmt.Errorf("%w: the source negotiated no format in %s", ErrSourceStalled, timeout)
}

// capsSize reads width and height from a caps event.
func capsSize(info *gst.PadProbeInfo) (int, int, bool) {
	ev := info.GetEvent()
	if ev == nil {
		return 0, 0, false
	}
	if st := ev.GetStructure(); st == nil || st.GetName() != "GstEventCaps" {
		return 0, 0, false
	}
	caps := ev.ParseCaps()
	if caps == nil || caps.GetSize() == 0 {
		return 0, 0, false
	}
	st := caps.GetStructure(0)
	w, ok1 := st.GetInt("width")
	h, ok2 := st.GetInt("height")
	if !ok1 || !ok2 || w <= 0 || h <= 0 {
		return 0, 0, false
	}
	return int(w), int(h), true
}

// build parses the encoder pipeline for a source of srcW x srcH.
func (b *LinuxBackend) build(ctx context.Context, p Profile, enc Encoder, path CapturePath, spec sourceSpec, srcW, srcH int, choice portal.Choice) (*LinuxStream, error) {
	layers := FitLayers(p.Layers, srcW, srcH)
	desc, err := linuxPipelineDescription(path, layers, enc, p.GOP)
	if err != nil {
		return nil, err
	}
	b.opts.Log.Debug("pipeline", "desc", desc)
	pipeline, err := parsePipeline(desc)
	if err != nil {
		return nil, err
	}
	s := &LinuxStream{
		gstStream:  newGstStream(enc, p.Audio),
		log:        b.opts.Log,
		opts:       b.opts,
		path:       path,
		layers:     layers,
		spec:       spec,
		choice:     choice,
		pipeline:   pipeline,
		policy:     newSourcePolicy(time.Now()),
		restartReq: make(chan restartReason, 4),
		specReq:    make(chan func(*sourceSpec)),
		events:     make(chan SourceEvent, 32),
		firstFrame: make(chan struct{}),
		still:      newStillDetector(b.opts.StillPause, layers[0], time.Now()),
	}
	s.pipelines = []gst.Pipeline{pipeline}
	s.gstStream.log = b.opts.Log
	ok := false
	defer func() {
		if !ok {
			s.release()
		}
	}()
	if err := s.attachLayers(pipeline, layers); err != nil {
		return nil, err
	}
	s.attachThumbnail(pipeline)
	if s.proxySrc = pipeline.GetByName(captureSrcName); s.proxySrc == nil {
		return nil, errors.New("encoder pipeline has no capture proxysrc")
	}
	for _, q := range []string{"capq", "bgq"} {
		fixLatency(pipeline.GetByName(q))
	}
	if s.mixerPad = pipeline.GetByName(mixerName).GetStaticPad("sink_1"); s.mixerPad == nil {
		return nil, errors.New("mixer has no capture pad")
	}
	s.applyAlpha(s.mixerPad)
	// The capture pipeline is not in s.pipelines: it is replaced at runtime, and stopping it
	// is bounded (removeSource).
	s.onStop = append(s.onStop, s.removeSource)
	if s.still != nil {
		top := layers[0].RID
		s.tap = func(f EncodedFrame) {
			if f.RID == top {
				still := s.still.frame(time.Now(), len(f.Data), f.Keyframe)
				s.setPause(func(ps *pauseState) { ps.still = still })
			}
		}
	}
	ok = true
	return s, nil
}

// fixLatency corrects the latency reported through a leaky queue into the mixer. The
// black gltestsrc (and proxysrc) answer with a maximum below their minimum, so the mixer
// cannot configure its latency and posts a "clock problem" warning on every frame. A
// leaky queue can always drop, so the maximum becomes "unlimited".
func fixLatency(queue gst.Element) {
	if queue == nil {
		return
	}
	pad := queue.GetStaticPad("src")
	if pad == nil {
		return
	}
	pad.AddProbe(gst.PadProbeTypeQueryUpstream|gst.PadProbeTypePull, func(_ gst.Pad, info *gst.PadProbeInfo) gst.PadProbeReturn {
		q := info.GetQuery()
		if q == nil {
			return gst.PadProbeOK
		}
		if st := q.GetStructure(); st == nil || st.GetName() != "GstQueryLatency" {
			return gst.PadProbeOK
		}
		live, minLatency, maxLatency := q.ParseLatency()
		if maxLatency != gst.ClockTimeNone && maxLatency < minLatency {
			q.SetLatency(live, minLatency, gst.ClockTimeNone)
		}
		return gst.PadProbeOK
	})
}

// LinuxStream is a running capture.
type LinuxStream struct {
	*gstStream
	log    *slog.Logger
	opts   LinuxOptions
	path   CapturePath
	layers []Layer

	session  *portal.Session
	kwin     *compositor.KWin
	windowID string
	choice   portal.Choice

	pipeline gst.Pipeline
	mixerPad gst.Pad
	proxySrc gst.Element
	// branchMu guards branch and spec: control replaces the capture while Stop removes it.
	branchMu sync.Mutex
	branch   *sourceBranch
	spec     sourceSpec

	policy     *sourcePolicy
	restartReq chan restartReason
	// specReq changes the capture spec and restarts the branch (control goroutine).
	specReq     chan func(*sourceSpec)
	events      chan SourceEvent
	firstFrame  chan struct{}
	firstOnce   sync.Once
	captured    atomic.Uint64
	restarts    atomic.Int64
	restartedAt atomic.Int64
	still       *stillDetector

	pauseMu sync.Mutex
	pause   pauseState
	paused  bool
	alphaOn atomic.Bool // the mixer shows black
	srcW    atomic.Int64
	srcH    atomic.Int64

	audioCap audio.Capture
	audioApp AudioApp
	// audioMute is the volume element of the audio pipeline; muted follows the curtain.
	audioMute   gst.Element
	audioMuted  atomic.Bool
	audioMuteMu sync.Mutex
}

// sourceBranch is one capture pipeline (pipewiresrc → appsink). It is a pipeline of its
// own, not a bin in the encoder pipeline: on KWin 6.8 a pipewiresrc that renegotiates a
// window's new size got no buffer for ~9 s, and while it sat in the encoder pipeline the
// mixer and every encoder stopped with it (this task's window run). Apart, its caps and
// stalls never reach the mixer, which goes on from the last frame.
type sourceBranch struct {
	pipeline gst.Pipeline
	remote   *os.File
	done     chan struct{}
	// detach removes the pad probes, which hold the stream (gstStream.release).
	detach func()
}

// run starts the encoder pipeline and the first capture pipeline and waits for the first
// frame. When DMA-BUF frames never come, it retries once with shared memory.
func (s *LinuxStream) run(ctx context.Context) error {
	// One clock and one base time, chosen here, for this pipeline and every capture
	// pipeline (addSource copies them), so capture timestamps are this pipeline's running
	// time from the first frame on.
	//
	// This pipeline cannot reach PLAYING before the first capture frame: its appsinks wait
	// for a preroll buffer, and the mixer produces none until its capture pad has data.
	// The capture used to be added only after waiting for PLAYING, so every start sat out
	// that wait's 5 s timeout, then the mixer caught up 5 s of output timestamps at once
	// (~300 black frames through the encoders) while holding the capture's frames, and the
	// first capture pipeline ran at 24–30 fps until a "warm-up" restart (PRs #33, #34).
	clock := gst.SystemClockObtain()
	s.pipeline.UseClock(clock)
	s.pipeline.SetStartTime(gst.ClockTimeNone)
	s.pipeline.SetBaseTime(clock.GetTime())
	if err := play(s.pipeline); err != nil {
		return err
	}
	go s.watchBus(s.pipeline, gstError, func(w string) { s.log.Debug("gstreamer warning", "msg", w) })
	s.branchMu.Lock()
	err := s.addSource()
	s.branchMu.Unlock()
	if err != nil {
		return err
	}
	wait := func() error {
		t := time.NewTimer(s.policy.frameTimeout)
		defer t.Stop()
		select {
		case <-s.firstFrame:
			return nil
		case err := <-s.errs:
			return err
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			return fmt.Errorf("%w: no frame from the source in %s", ErrSourceStalled, s.policy.frameTimeout)
		}
	}
	err = wait()
	if errors.Is(err, ErrSourceStalled) && s.spec.testPattern == "" && !s.spec.shm && s.path == PathGL {
		s.log.Warn("no DMA-BUF frames from the source; retrying with shared memory (more CPU)")
		s.replaceSource(restartTimeout, func(sp *sourceSpec) { sp.shm = true })
		err = wait()
	}
	if err != nil {
		return err
	}
	go s.control()
	return nil
}

// addSource (branchMu held) starts a capture pipeline on the encoder pipeline's clock and
// base time (as proxysink/proxysrc require), so its timestamps are the encoder pipeline's
// running time, and points the proxysrc at its proxysink.
func (s *LinuxStream) addSource() error {
	spec := s.spec
	var remote *os.File
	if spec.testPattern == "" {
		var err error
		if remote, err = s.session.OpenPipeWireRemote(); err != nil {
			return err
		}
		spec.fd = int(remote.Fd())
	}
	closeRemote := func() {
		if remote != nil {
			_ = remote.Close()
		}
	}
	p, err := parsePipeline(linuxSourceDescription(s.path, spec))
	if err != nil {
		closeRemote()
		return fmt.Errorf("capture pipeline: %w", err)
	}
	sink := p.GetByName(captureSinkName)
	pad := sink.GetStaticPad("sink")
	if pad == nil {
		closeRemote()
		return errors.New("capture pipeline has no proxysink")
	}
	b := &sourceBranch{pipeline: p, remote: remote, done: make(chan struct{})}
	// The probes never take a Go reference to the buffer (see linuxSourceDescription).
	// They hold this stream, so they are removed with the branch (release).
	frames := pad.AddProbe(gst.PadProbeTypeBuffer, func(gst.Pad, *gst.PadProbeInfo) gst.PadProbeReturn {
		s.policy.onFrame(time.Now())
		s.captured.Add(1)
		s.firstOnce.Do(func() { close(s.firstFrame) })
		return gst.PadProbeOK
	})
	caps := pad.AddProbe(gst.PadProbeTypeEventDownstream, func(_ gst.Pad, info *gst.PadProbeInfo) gst.PadProbeReturn {
		if w, h, ok := capsSize(info); ok {
			s.onCaps(w, h)
		}
		return gst.PadProbeOK
	})
	b.detach = func() {
		pad.RemoveProbe(frames)
		pad.RemoveProbe(caps)
	}
	s.proxySrc.SetObjectProperty("proxysink", sink)
	p.UseClock(s.pipeline.GetPipelineClock())
	p.SetStartTime(gst.ClockTimeNone)
	p.SetBaseTime(s.pipeline.GetBaseTime())
	if err := play(p); err != nil {
		b.detach()
		closeRemote()
		return fmt.Errorf("capture pipeline: %w", err)
	}
	go s.watchCapture(b)
	s.branch = b
	return nil
}

// watchCapture maps the capture pipeline's bus: the window closing ends the stream, any
// other error restarts the capture.
func (s *LinuxStream) watchCapture(b *sourceBranch) {
	bus := b.pipeline.GetBus()
	for {
		select {
		case <-b.done:
			return
		case <-s.done:
			return
		default:
		}
		msg := bus.TimedPop(gst.ClockTime(100 * time.Millisecond))
		if msg == nil {
			continue
		}
		var err error
		switch msg.Type() {
		case gst.MessageError:
			err = gstError(msg)
		case gst.MessageEOS:
			err = errors.New("capture: end of stream")
		default:
			continue
		}
		select {
		case <-b.done:
			return // an old branch being torn down
		default:
		}
		if isSourceEndedMessage(err.Error()) {
			s.fail(ErrSourceEnded)
			return
		}
		s.log.Warn("capture error, restarting", "err", err)
		select {
		case s.restartReq <- restartTimeout:
		default:
		}
		return
	}
}

// onCaps places the source in the output (letterboxed) and asks for a restart on a size
// change. It runs on the capture's streaming thread.
func (s *LinuxStream) onCaps(w, h int) {
	reason := s.policy.onCaps(w, h)
	top := s.layers[0]
	r := FitRect(w, h, top.Width, top.Height)
	s.mixerPad.SetObjectProperty("xpos", int32(r.X))
	s.mixerPad.SetObjectProperty("ypos", int32(r.Y))
	s.mixerPad.SetObjectProperty("width", int32(r.W))
	s.mixerPad.SetObjectProperty("height", int32(r.H))
	prevW, prevH := s.srcW.Swap(int64(w)), s.srcH.Swap(int64(h))
	if prevW != 0 && (prevW != int64(w) || prevH != int64(h)) {
		s.emit(SourceEvent{Resized: true, Width: w, Height: h})
	}
	if reason != restartNone {
		select {
		case s.restartReq <- reason:
		default:
		}
	}
}

// removeSource stops the current capture pipeline, if any. Stopping a pipewiresrc that is stuck
// in a renegotiation can block, so it is bounded: a stuck one is left behind rather than
// stalling the stream.
func (s *LinuxStream) removeSource() {
	s.branchMu.Lock()
	defer s.branchMu.Unlock()
	s.removeSourceLocked()
}

func (s *LinuxStream) removeSourceLocked() {
	b := s.branch
	if b == nil {
		return
	}
	s.branch = nil
	close(b.done)
	stopped := make(chan struct{})
	go func() {
		b.pipeline.SetState(gst.StateNull)
		b.detach()
		if b.remote != nil {
			_ = b.remote.Close()
		}
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		s.log.Warn("the old capture pipeline did not stop in 3 s; leaving it behind")
	}
}

// replaceSource restarts the capture, after applying the spec changes; the encoders keep
// running on the mixer.
func (s *LinuxStream) replaceSource(reason restartReason, changes ...func(*sourceSpec)) {
	s.branchMu.Lock()
	defer s.branchMu.Unlock()
	if s.stopped() {
		return
	}
	for _, c := range changes {
		c(&s.spec)
	}
	w, h := s.policy.size()
	if !s.policy.allow(time.Now(), reason) {
		s.log.Warn("capture restart skipped: too many in a short time", "reason", reason)
		return
	}
	s.restarts.Add(1)
	s.restartedAt.Store(time.Now().UnixNano())
	s.log.Info("restarting the capture", "reason", reason, "lastSize", fmt.Sprintf("%dx%d", w, h))
	s.removeSourceLocked()
	if err := s.addSource(); err != nil {
		s.fail(fmt.Errorf("restart the capture: %w", err))
	}
}

func (s *LinuxStream) lastRestart() time.Time { return time.Unix(0, s.restartedAt.Load()) }

// resizeSettle is how long the shared window's size must stay put before the capture
// restarts for it: a drag resizes many times a second.
const resizeSettle = 300 * time.Millisecond

// control restarts the capture when asked, runs the frame watchdog, follows the shared
// window (minimized, resized) and ends the stream with the portal session.
func (s *LinuxStream) control() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	var updates <-chan compositor.Snapshot
	var winW, winH int
	if s.kwin != nil && s.windowID != "" {
		updates = s.kwin.Updates()
		if w, ok := s.kwin.Snapshot().Window(s.windowID); ok {
			winW, winH = w.ClientW, w.ClientH
		}
	}
	var closed <-chan struct{}
	if s.session != nil {
		closed = s.session.Closed()
	}
	// KWin says a window was resized at once; the stream's own caps come seconds later
	// (early runs), so the window's size drives the restart.
	settle := time.NewTimer(time.Hour)
	settle.Stop()
	var resizedAt time.Time
	defer settle.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-closed:
			s.fail(ErrSourceEnded)
			return
		case r := <-s.restartReq:
			s.replaceSource(r)
		case change := <-s.specReq:
			s.replaceSource(restartResize, change)
		case <-settle.C:
			// The stream's caps may already have restarted the capture for this resize.
			if s.lastRestart().Before(resizedAt) {
				s.replaceSource(restartResize)
			}
		case <-tick.C:
			r, err := s.policy.check(time.Now())
			if err != nil {
				s.fail(err)
				return
			}
			if r != restartNone {
				s.replaceSource(r)
			}
		case snap := <-updates:
			w, ok := snap.Window(s.windowID)
			if !ok {
				continue
			}
			s.setPause(func(ps *pauseState) { ps.minimized = w.Minimized })
			if w.ClientW != winW || w.ClientH != winH {
				winW, winH = w.ClientW, w.ClientH
				resizedAt = time.Now()
				settle.Reset(resizeSettle)
			}
		}
	}
}

// setPause changes the pause state; a change of "paused" shows or hides the black frame
// and emits an event.
func (s *LinuxStream) setPause(change func(*pauseState)) {
	s.pauseMu.Lock()
	change(&s.pause)
	paused, reason := s.pause.paused()
	changed := paused != s.paused
	s.paused = paused
	muted := s.pause.audioMuted()
	s.pauseMu.Unlock()
	if s.audioMuted.Swap(muted) != muted {
		s.applyAudioMute()
	}
	if !changed {
		return
	}
	s.alphaOn.Store(paused)
	if s.mixerPad != nil {
		s.mixerPad.SetObjectProperty("zorder", uint32(1))
		s.applyAlpha(s.mixerPad)
	}
	s.log.Info("source paused state", "paused", paused, "reason", reason)
	s.emit(SourceEvent{Paused: paused, PauseReason: reason})
}

// applyAlpha hides the source behind the mixer's black background while paused: the
// helper-side black frame of the privacy curtain. The track keeps
// sending, so viewers stay connected.
func (s *LinuxStream) applyAlpha(pad gst.Pad) {
	alpha := 1.0
	if s.alphaOn.Load() {
		alpha = 0
	}
	pad.SetObjectProperty("alpha", alpha)
}

// applyAudioMute sends silence instead of the app audio while the curtain is on. The
// mute is at the PCM, before the encoder, so the Opus track keeps its frames.
func (s *LinuxStream) applyAudioMute() {
	s.audioMuteMu.Lock()
	defer s.audioMuteMu.Unlock()
	if s.audioMute != nil {
		s.audioMute.SetObjectProperty("mute", s.audioMuted.Load())
	}
}

func (s *LinuxStream) emit(e SourceEvent) {
	select {
	case s.events <- e:
	default:
		s.log.Warn("source event dropped (nobody reading)", "event", fmt.Sprintf("%+v", e))
	}
}

// startAudio captures one app's audio into a second pipeline, so an audio failure never
// stops the video.
func (s *LinuxStream) startAudio(ctx context.Context, window compositor.Window) {
	sel := audio.Selector{Name: s.opts.AudioApp}
	if s.opts.AudioApp == "window" {
		if window.PID <= 0 {
			s.log.Warn("audio: the shared window's app is unknown; no audio. Pass --audio-app <name>")
			return
		}
		// By process tree only: a name would also match another instance of the same
		// app (a second browser, or a viewer tab playing this very stream).
		sel = audio.Selector{PID: window.PID, Descends: audio.Descends}
	}
	capt, err := s.opts.StartAudio(ctx, sel, s.log)
	if err != nil {
		s.log.Warn("audio: capture did not start; streaming without audio", "err", err)
		return
	}
	desc := audioPipelineDescription(int(capt.PCM().Fd()), audio.SampleRate, audio.Channels, audioSinkName)
	pipeline, err := parsePipeline(desc)
	if err == nil {
		err = s.attachAudio(pipeline)
	}
	if err == nil {
		err = play(pipeline)
	}
	if err != nil {
		_ = capt.Stop()
		s.log.Warn("audio: encoder did not start; streaming without audio", "err", err)
		return
	}
	s.audioCap = capt
	s.audioMute = pipeline.GetByName(audioMuteName)
	s.applyAudioMute()
	s.audioApp = AudioApp{Name: cmp.Or(window.Class, s.opts.AudioApp), PID: window.PID, Binary: audio.ProcessName(window.PID)}
	s.pipelines = append(s.pipelines, pipeline)
	s.onStop = append(s.onStop, func() { _ = capt.Stop() })
	go s.logAudioBus(pipeline)
}

func (s *LinuxStream) logAudioBus(p gst.Pipeline) {
	bus := p.GetBus()
	for !s.stopped() {
		msg := bus.TimedPop(gst.ClockTime(200 * time.Millisecond))
		if msg == nil {
			continue
		}
		switch msg.Type() {
		case gst.MessageError:
			s.log.Warn("audio pipeline stopped; the video goes on", "err", gstError(msg))
			return
		case gst.MessageEOS:
			s.log.Warn("audio capture ended; the video goes on")
			return
		}
	}
}

// Events reports pause changes and resizes. Nobody has to read it.
func (s *LinuxStream) Events() <-chan SourceEvent { return s.events }

// SetCurtain turns the privacy curtain on or off: a black frame and the paused flag,
// without stopping the stream.
func (s *LinuxStream) SetCurtain(on bool) { s.setPause(func(ps *pauseState) { ps.curtain = on }) }

// Paused is the current pause state.
func (s *LinuxStream) Paused() (bool, string) {
	s.pauseMu.Lock()
	defer s.pauseMu.Unlock()
	p, r := s.pause.paused()
	return p, string(r)
}

// AudioApp is whose audio the stream captures; false without app audio.
func (s *LinuxStream) AudioApp() (AudioApp, bool) {
	return s.audioApp, s.audioCap != nil
}

// PingSource says what the video frame shows, so a viewer's pointer ping lands on the
// shared monitor or window (PROTOCOL.md §7.9). It needs KWin: without it (another
// desktop, the test pattern) the stream cannot place pings and announces no overlay.
func (s *LinuxStream) PingSource() (overlay.Source, compositor.Snapshot, bool) {
	if s.kwin == nil || len(s.layers) == 0 {
		return overlay.Source{}, compositor.Snapshot{}, false
	}
	top := s.layers[0]
	srcW, srcH := int(s.srcW.Load()), int(s.srcH.Load())
	content := FitRect(srcW, srcH, top.Width, top.Height)
	src := overlay.Source{
		Window: s.choice.Kind == portal.KindWindow,
		FrameW: top.Width, FrameH: top.Height,
		Content: overlay.Rect{X: content.X, Y: content.Y, W: content.W, H: content.H},
		SrcW:    srcW, SrcH: srcH,
		Output:   s.choice.Output,
		WindowID: s.windowID,
	}
	if (src.Window && src.WindowID == "") || (!src.Window && src.Output == "") {
		return overlay.Source{}, compositor.Snapshot{}, false
	}
	return src, s.kwin.Snapshot(), true
}

// SharedSource is what is being shared, for the UI.
func (s *LinuxStream) SharedSource() portal.Source { return s.choice.Source() }

// Layers are the layer sizes after fitting the source's aspect ratio.
func (s *LinuxStream) Layers() []Layer { return s.layers }

// CaptureStats returns the counters.
func (s *LinuxStream) CaptureStats() CaptureStats {
	st := CaptureStats{Captured: s.captured.Load(), Restarts: s.restarts.Load(), Width: int(s.srcW.Load()), Height: int(s.srcH.Load())}
	if s.audioCap != nil {
		st.AudioLinked = s.audioCap.Linked()
	}
	return st
}

// refreshRates is compositor.RefreshRates; tests replace it.
var refreshRates = compositor.RefreshRates

// refreshRate is the named output's refresh rate in Hz, 0 when unknown.
func refreshRate(ctx context.Context, output string) float64 {
	if output == "" {
		return 0
	}
	rates, err := refreshRates(ctx)
	if err != nil {
		return 0
	}
	return rates[output]
}
