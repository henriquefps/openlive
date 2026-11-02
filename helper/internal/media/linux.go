// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/henriquefps/openlive/helper/internal/portal"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// This file is the part of the Linux backend (portal + PipeWire capture,
// GL scaling, NVENC, VA-API or x264) that needs neither GStreamer nor a desktop, so CI tests it:
// output sizes, the letterbox, the source-restart policy, the paused state and the
// pipeline descriptions. linux_gst.go runs them.

// CapturePath is how frames get from PipeWire to the encoders.
type CapturePath string

const (
	// PathAuto picks GL when GStreamer has the GL elements.
	PathAuto CapturePath = "auto"
	// PathGL: DMA-BUF → glupload → glcolorconvert → glvideomixer (scale + letterbox) →
	// per layer glcolorscale → cudaupload (NVENC), gldownload → vapostproc (VA-API) or
	// gldownload (x264). Phase 0 P4.
	PathGL CapturePath = "gl"
	// PathCPU: shared-memory frames, videoconvert/compositor/videoscale on the CPU. P4
	// measured that it does not hold 1080p60.
	PathCPU CapturePath = "cpu"
)

// ParseCapturePath validates a --capture-path value.
func ParseCapturePath(s string) (CapturePath, error) {
	switch p := CapturePath(s); p {
	case PathAuto, PathGL, PathCPU:
		return p, nil
	}
	return "", fmt.Errorf("unknown capture path %q (want auto, gl or cpu)", s)
}

// ResolveCapturePath turns auto into gl or cpu.
func ResolveCapturePath(p CapturePath, enc Encoder, has func(string) bool) CapturePath {
	if p != PathAuto {
		return p
	}
	for _, e := range []string{"glupload", "glcolorconvert", "glvideomixer", "glcolorscale"} {
		if !has(e) {
			return PathCPU
		}
	}
	if enc == EncoderNVENC && !has("cudaupload") {
		return PathCPU
	}
	if enc.IsVA() && !has("vapostproc") {
		return PathCPU
	}
	return PathGL
}

// PortalSources lists what can be shared through the portal: the system dialog for a
// monitor and for a window (always shown), and the last monitor and window shared, which
// the portal restores without the dialog, when the store has a restore token for them. A
// window's own app audio can be captured ("window" as the audio app).
func PortalSources(store portal.Store) []Source {
	out := []Source{
		{ID: PortalScreenID, Kind: SourceScreen, Label: "A monitor (picked in the system dialog)"},
		{ID: PortalWindowID, Kind: SourceWindow, Label: "A window (picked in the system dialog)", HasAudio: true},
	}
	last := []struct {
		id   string
		kind portal.Kind
		src  SourceKind
	}{{PortalLastScreenID, portal.KindMonitor, SourceScreen}, {PortalLastWindowID, portal.KindWindow, SourceWindow}}
	for _, l := range last {
		rec, err := store.Load(l.kind)
		if err != nil || rec.Token == "" || rec.Choice.Kind != l.kind {
			continue
		}
		shared := rec.Choice.Source()
		s := Source{ID: l.id, Kind: l.src, Label: shared.Label, Width: shared.Width, Height: shared.Height, Restored: true}
		if l.kind == portal.KindWindow {
			s.AppName, s.HasAudio = rec.Choice.WindowClass, true
		}
		out = append(out, s)
	}
	return out
}

// restores says whether starting src may use the saved restore token (no dialog): never for
// the pickers, which promise the dialog, nor with --pick.
func restores(src Source, pick bool) bool { return !pick && !src.IsPortalPicker() }

// MonitorPixelSize is a monitor stream's frame size in pixels. The portal reports a
// stream's size in compositor (logical) coordinates, while PipeWire delivers the output's
// pixels: on a scaled output (KDE scale 2: 1920x1080 logical, 3840x2160 pixels) the
// layers fitted to the portal's size were capped at half the real resolution. When the
// portal's size is the output's logical size and the output is scaled, it is scaled up;
// otherwise the portal's size is already in pixels and stays.
func MonitorPixelSize(portalW, portalH, logicalW, logicalH int, scale float64) (int, int) {
	if scale <= 0 || scale == 1 || !near(portalW, logicalW) || !near(portalH, logicalH) {
		return portalW, portalH
	}
	return int(math.Round(float64(logicalW) * scale)), int(math.Round(float64(logicalH) * scale))
}

// near allows the rounding of fractional scales (as compositor.MatchOutput does).
func near(a, b int) bool { return a-b <= 2 && b-a <= 2 }

// CapFPS lowers every layer's frame rate to the monitor's refresh rate (hz, rounded:
// 59.94 → 60), so a 120 fps preset on a 60 Hz monitor captures and encodes 60 fps instead
// of repeating frames. It reports whether anything changed; an
// unknown rate (0) changes nothing.
func CapFPS(layers []Layer, hz float64) ([]Layer, bool) {
	limit := int(math.Round(hz))
	if limit <= 0 {
		return layers, false
	}
	out := slices.Clone(layers)
	changed := false
	for i := range out {
		if out[i].FPS > limit {
			out[i].FPS, changed = limit, true
		}
	}
	return out, changed
}

// maxH264Width is NVENC's H.264 limit (and a sane one for x264 at these rates).
const maxH264Width = 4096

func even(v int) int { return max(2, v&^1) }

// mbAlign is the H.264 macroblock size. Layer widths are multiples of it, so the encoded
// width needs no frame cropping on the right (only the bottom rows of a 1080-line frame are
// cropped, as in every 1080p stream); smaller-than-preset heights are aligned too.
const mbAlign = 16

// alignMB rounds v to the nearest multiple of 16 that is at most limit (and at least 16).
func alignMB(v float64, limit int) int {
	a := int(math.Round(v/mbAlign)) * mbAlign
	if a > limit {
		a = limit / mbAlign * mbAlign
	}
	return max(mbAlign, a)
}

// FitLayers sizes the layers for a source of srcW x srcH: each keeps its preset height
// and takes the source's aspect ratio (Phase 0 P4: a 3440x1440 monitor at the 1080p
// preset is 2576x1080), never upscales the source, and stays within NVENC's width. Widths
// are multiples of 16, and so is a height below the preset's (a small window); the mixer
// letterboxes the few pixels this takes off the aspect ratio (FitRect). The size is fixed
// for the whole capture: a resized window is letterboxed into it.
// Unknown source sizes leave the layers as they are.
func FitLayers(layers []Layer, srcW, srcH int) []Layer {
	out := append([]Layer(nil), layers...)
	if srcW <= 0 || srcH <= 0 {
		return out
	}
	for i := range out {
		h := out[i].Height
		if srcH < h {
			h = max(mbAlign, srcH/mbAlign*mbAlign)
		}
		w := alignMB(float64(srcW*h)/float64(srcH), min(srcW, maxH264Width))
		if float64(srcW*h)/float64(srcH) > maxH264Width {
			h = even(srcH * w / srcW)
		}
		out[i].Width, out[i].Height = w, h
	}
	return out
}

// Rect is a placement inside the output frame.
type Rect struct{ X, Y, W, H int }

// FitRect places a srcW x srcH frame inside outW x outH, keeping its aspect ratio,
// centered (the rest is black). A window resized during a stream is scaled into the
// fixed output size this way (Phase 0 P7).
func FitRect(srcW, srcH, outW, outH int) Rect {
	if srcW <= 0 || srcH <= 0 {
		return Rect{0, 0, outW, outH}
	}
	w, h := outW, srcH*outW/srcW
	if h > outH {
		w, h = srcW*outH/srcH, outH
	}
	w, h = min(even(w), outW), min(even(h), outH)
	return Rect{X: (outW - w) / 2, Y: (outH - h) / 2, W: w, H: h}
}

// sourcePolicy decides when the capture branch (pipewiresrc → glupload) restarts.
//
//   - A size change restarts it: pipewiresrc negotiates the new size and then stalls
//     (Phase 0 P7), while a fresh one runs at full rate.
//   - No frame for frameTimeout restarts it once; a restarted branch that still delivers
//     nothing within frameTimeout is fatal (the source never negotiated).
//   - Restarts are rate-limited, so a window being dragged to a new size restarts once
//     per burst and a broken source cannot loop forever.
type sourcePolicy struct {
	frameTimeout time.Duration
	burst        int
	burstWindow  time.Duration

	mu sync.Mutex
	// Size of the running branch, 0 until its first caps.
	w, h int
	// started is when the running branch started; lastFrame its latest frame.
	started   time.Time
	lastFrame time.Time
	frames    uint64
	restarts  []time.Time
	// timedOut marks a branch started because the previous one timed out.
	timedOut bool
}

func newSourcePolicy(now time.Time) *sourcePolicy {
	return &sourcePolicy{frameTimeout: 10 * time.Second, burst: 6, burstWindow: 30 * time.Second, started: now}
}

// restartReason says why the branch must restart; "" when it must not.
type restartReason string

const (
	restartNone    restartReason = ""
	restartResize  restartReason = "size changed"
	restartTimeout restartReason = "no frame"
)

// onCaps records a negotiated size; it reports whether the branch must restart.
func (p *sourcePolicy) onCaps(w, h int) restartReason {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.w == 0 && p.h == 0 {
		p.w, p.h = w, h
		return restartNone
	}
	if w == p.w && h == p.h {
		return restartNone
	}
	return restartResize
}

// onFrame records a frame leaving the source.
func (p *sourcePolicy) onFrame(now time.Time) {
	p.mu.Lock()
	p.lastFrame = now
	p.frames++
	p.timedOut = false
	p.mu.Unlock()
}

// check runs on a timer. It reports a restart, or an error when the source is dead.
func (p *sourcePolicy) check(now time.Time) (restartReason, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	since := p.started
	if p.lastFrame.After(since) {
		since = p.lastFrame
	}
	if now.Sub(since) < p.frameTimeout {
		return restartNone, nil
	}
	if p.timedOut {
		if p.frames == 0 {
			return restartNone, fmt.Errorf("%w: no frame from the source in %s", ErrSourceStalled, p.frameTimeout)
		}
		return restartNone, fmt.Errorf("%w: no frame from the source for %s, also after a restart", ErrSourceStalled, 2*p.frameTimeout)
	}
	return restartTimeout, nil
}

// allow reports whether another restart fits the rate limit, and counts it.
func (p *sourcePolicy) allow(now time.Time, reason restartReason) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	kept := p.restarts[:0]
	for _, t := range p.restarts {
		if now.Sub(t) < p.burstWindow {
			kept = append(kept, t)
		}
	}
	p.restarts = kept
	if len(p.restarts) >= p.burst {
		return false
	}
	p.restarts = append(p.restarts, now)
	p.w, p.h = 0, 0
	p.started = now
	p.timedOut = reason == restartTimeout
	return true
}

// size is the running branch's negotiated size.
func (p *sourcePolicy) size() (int, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.w, p.h
}

// ErrSourceEnded means the shared window was closed or the portal session ended (the
// person stopped sharing from the desktop). The stream should end normally.
var ErrSourceEnded = errors.New("the shared source ended")

// ErrSourceStalled means the source stopped delivering frames and a restart did not help.
var ErrSourceStalled = errors.New("the capture source stalled")

// isSourceEndedMessage recognises pipewiresrc's error when its target node goes away
// (a closed window: "stream error: target not found", Phase 0 P7).
func isSourceEndedMessage(text string) bool {
	t := strings.ToLower(text)
	return strings.Contains(t, "target not found") || strings.Contains(t, "stream error: unconnected") ||
		strings.Contains(t, "node has been removed")
}

// SourceEvent tells the caller about the source while it streams.
type SourceEvent struct {
	// Paused changes: the room gets stream.update {paused, pauseReason}.
	Paused      bool
	PauseReason protocol.PauseReason
	// Resized is set when the source size changed (the output size does not).
	Resized       bool
	Width, Height int
}

// CaptureStats counts what came out of the capture branch.
type CaptureStats struct {
	Captured      uint64
	Restarts      int64
	Width, Height int
	AudioLinked   int
}

// pauseState combines the reasons for "paused". The privacy curtain wins over the
// others because it is the one the streamer chose.
type pauseState struct {
	curtain   bool
	minimized bool
	still     bool
}

// audioMuted is whether the stream's audio is replaced by silence: only the privacy
// curtain does it (as on macOS); a hidden or still source keeps its sound.
func (s pauseState) audioMuted() bool { return s.curtain }

func (s pauseState) paused() (bool, protocol.PauseReason) {
	switch {
	case s.curtain:
		return true, protocol.PauseReasonPrivacyCurtain
	case s.minimized, s.still:
		return true, protocol.PauseReasonSourceHidden
	}
	return false, ""
}

// stillDetector is the "content unchanged for N s" fallback for paused,
// off by default. It reads the top layer's encoded frame sizes instead of pixels: an
// unchanged frame encodes to a few hundred bytes of skipped macroblocks, so this needs
// no extra GPU readback (an extra GL consumer cost KWin frames in Phase 0 P7).
type stillDetector struct {
	after    time.Duration
	maxBytes int
	// lastChange is the latest frame bigger than maxBytes (keyframes excluded).
	lastChange time.Time
}

// newStillDetector returns nil when after is 0 (off). The threshold is 1/32 of a frame's
// share of the bitrate, at least 512 bytes.
func newStillDetector(after time.Duration, top Layer, now time.Time) *stillDetector {
	if after <= 0 {
		return nil
	}
	budget := top.Kbps * 1000 / 8 / max(1, top.FPS)
	return &stillDetector{after: after, maxBytes: max(512, budget/32), lastChange: now}
}

// frame feeds one top-layer frame and reports whether the content counts as still.
func (d *stillDetector) frame(now time.Time, size int, keyframe bool) bool {
	if !keyframe && size > d.maxBytes {
		d.lastChange = now
	}
	return now.Sub(d.lastChange) >= d.after
}

// linuxPipelineDescription is the encoder pipeline: an appsrc fed by the capture pipeline
// (linuxSourceDescription, replaceable while this one runs), the upload to GL, the mixer
// that scales and letterboxes the source into the fixed output size (and shows black for
// the curtain or a paused source), a tee, one encoder branch per layer, and the
// thumbnail branch (pipeline.go).
//
// The mixer's first pad is a live black 16x16 source stretched to the full frame. It keeps
// the mixer, and so the encoders, running at the output rate whatever the capture does: on
// KDE a restarted window capture can negotiate and then deliver nothing for seconds, and
// without a live input the mixer stopped producing (the viewer froze). It is also the black
// behind a paused source or the curtain. The mixer's output starts at its first input's
// time (start-time-selection=first), not at running time 0: the pipeline only reaches
// PLAYING with the first capture frame, and from 0 the mixer would first catch up on the
// time spent until then, a burst of black frames through every encoder.
//
//	GL:  glvideomixer → RGBA GLMemory W×H@fps → tee
//	       → per layer: [glcolorscale] → [videorate] → cudaupload → nvh264enc   (NVENC)
//	                    [glcolorscale] → [videorate] → gldownload → vapostproc → vah264enc (VA-API)
//	                    [glcolorscale] → gldownload → videoconvert → [videorate] → x264enc
//
// VA-API: gldownload exports the GL texture as a DMA-BUF when the EGL context can (Mesa
// can), and vapostproc imports it and converts to NV12 VA surfaces on the GPU, so frames
// never reach the CPU; without DMA-BUF export the caps fall back to system memory (one
// copy per frame).
//
//	CPU: compositor → W×H@fps → tee → per layer: videoscale → videorate → videoconvert → encoder
func linuxPipelineDescription(path CapturePath, layers []Layer, enc Encoder, gop time.Duration) (string, error) {
	if len(layers) == 0 {
		return "", fmt.Errorf("no layers")
	}
	top := layers[0]
	var b strings.Builder
	switch path {
	case PathGL:
		fmt.Fprintf(&b, "glvideomixer name=%s background=black latency=%d start-time-selection=first sink_0::width=%d sink_0::height=%d sink_0::zorder=0 "+
			"! video/x-raw(memory:GLMemory),format=RGBA,width=%d,height=%d,framerate=%d/1,pixel-aspect-ratio=1/1 ! tee name=t "+
			"gltestsrc is-live=true pattern=black ! video/x-raw(memory:GLMemory),format=RGBA,width=16,height=16,framerate=%d/1 "+
			"! queue name=bgq max-size-buffers=1 leaky=downstream ! %s.sink_0 "+
			"%s ! glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=RGBA ! %s.sink_1 ",
			mixerName, mixerLatency.Nanoseconds(), top.Width, top.Height, top.Width, top.Height, top.FPS, top.FPS, mixerName, captureAppsrc, mixerName)
	case PathCPU:
		fmt.Fprintf(&b, "compositor name=%s background=black latency=%d start-time-selection=first sink_0::width=%d sink_0::height=%d sink_0::zorder=0 "+
			"! video/x-raw,format=I420,width=%d,height=%d,framerate=%d/1,pixel-aspect-ratio=1/1 ! tee name=t "+
			"videotestsrc is-live=true pattern=black ! video/x-raw,width=16,height=16,framerate=%d/1 "+
			"! queue name=bgq max-size-buffers=1 leaky=downstream ! %s.sink_0 "+
			"%s ! videoconvert ! %s.sink_1 ",
			mixerName, mixerLatency.Nanoseconds(), top.Width, top.Height, top.Width, top.Height, top.FPS, top.FPS, mixerName, captureAppsrc, mixerName)
	default:
		return "", fmt.Errorf("unknown capture path %q", path)
	}
	for _, l := range layers {
		encDesc, err := encoderElement(enc, l, gop)
		if err != nil {
			return "", err
		}
		scaled := l.Width != top.Width || l.Height != top.Height
		slower := l.FPS != top.FPS
		fmt.Fprintf(&b, "t. ! queue max-size-buffers=2 leaky=downstream ")
		switch {
		case path == PathGL && enc == EncoderNVENC:
			if scaled {
				fmt.Fprintf(&b, "! glcolorscale ! video/x-raw(memory:GLMemory),width=%d,height=%d ", l.Width, l.Height)
			}
			if slower {
				fmt.Fprintf(&b, "! videorate drop-only=true ! video/x-raw(memory:GLMemory),framerate=%d/1 ", l.FPS)
			}
			b.WriteString("! cudaupload ! video/x-raw(memory:CUDAMemory) ")
		case path == PathGL && enc.IsVA():
			if scaled {
				fmt.Fprintf(&b, "! glcolorscale ! video/x-raw(memory:GLMemory),width=%d,height=%d ", l.Width, l.Height)
			}
			if slower {
				fmt.Fprintf(&b, "! videorate drop-only=true ! video/x-raw(memory:GLMemory),framerate=%d/1 ", l.FPS)
			}
			b.WriteString("! gldownload ! vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ")
		case path == PathGL:
			if scaled {
				fmt.Fprintf(&b, "! glcolorscale ! video/x-raw(memory:GLMemory),width=%d,height=%d ", l.Width, l.Height)
			}
			b.WriteString("! gldownload ! videoconvert ! video/x-raw,format=I420 ")
			if slower {
				fmt.Fprintf(&b, "! videorate drop-only=true ! video/x-raw,framerate=%d/1 ", l.FPS)
			}
		default:
			fmt.Fprintf(&b, "! videoscale ! videorate drop-only=true ! video/x-raw,width=%d,height=%d,framerate=%d/1 ! videoconvert ! video/x-raw,format=%s ",
				l.Width, l.Height, l.FPS, map[Encoder]string{EncoderNVENC: "NV12", EncoderVA: "NV12", EncoderVALowPower: "NV12", EncoderX264: "I420"}[enc])
		}
		fmt.Fprintf(&b, "! %s ! %s "+
			"! appsink name=%s emit-signals=true sync=false max-buffers=4 drop=false ", encDesc, parserElement(l), videoSinkName(l.RID))
	}
	if path == PathGL {
		// Drop frames, scale and convert in GL; only the small I420 frame is downloaded.
		fmt.Fprintf(&b, "t. ! queue max-size-buffers=1 leaky=downstream ! videorate drop-only=true ! video/x-raw(memory:GLMemory),framerate=%s "+
			"! glcolorscale ! video/x-raw(memory:GLMemory),width=%d,height=%d ! glcolorconvert ! video/x-raw(memory:GLMemory),format=I420 "+
			"! gldownload ! %s", thumbEvery, thumbWidth, thumbHeight(top.Width, top.Height), thumbSink)
	} else {
		b.WriteString(rawThumbBranch(top.Width, top.Height))
	}
	return strings.TrimSpace(b.String()), nil
}

// captureAppsrc receives the capture pipeline's frames. The leaky queue keeps one and
// drops the older, so the capture never waits for the encoders.
var captureAppsrc = fmt.Sprintf("proxysrc name=%s ! queue name=capq max-size-buffers=1 max-size-bytes=0 max-size-time=100000000 leaky=downstream", captureSrcName)

// mixerLatency is the mixer's extra wait for late input. Zero would make it output
// black frames whenever a capture frame is a little late; 20 ms is a bit over one frame
// at 60 fps.
const mixerLatency = 20 * time.Millisecond

const (
	mixerName = "mix"
	// sourceElementName is the capture element of the capture pipeline.
	sourceElementName = "vsrc"
	// captureSinkName and captureSrcName join the capture pipeline to the encoder one.
	captureSinkName = "capsink"
	captureSrcName  = "capsrc"
)

// sourceSpec says what one capture branch reads.
type sourceSpec struct {
	// fd is the portal's PipeWire remote; node the stream's object.serial.
	fd     int
	serial uint64
	// width and height pin the source size (a monitor); 0 lets it follow the source (a
	// window, whose size changes).
	width, height int
	fps           int
	// shm asks for shared-memory frames instead of DMA-BUFs.
	shm bool
	// testPattern replaces PipeWire with gltestsrc/videotestsrc (development and tests).
	testPattern string
}

// linuxSourceDescription is one capture pipeline: the source, its caps, and a proxysink
// that hands buffers, events and queries to the encoder pipeline's proxysrc (see
// sourceBranch). The frames never pass through Go: go-gst frees a pulled sample only in a
// GC finalizer, so an appsink held pipewiresrc's 3 pool buffers and cut a 60 fps window to
// the 1 fps keepalive.
//
// pipewiresrc keeps the encoder fed from a static window with keepalive-time and
// resend-last (Phase 0 P4). max-framerate is pinned: without it KWin delivers up to the
// monitor's refresh (175 Hz in P4). Only the encoder pipeline's glupload reads KWin's
// DMA-BUFs (one GL consumer, P7); its allocation query crosses the proxy, so DMA-BUF
// formats negotiate as in one pipeline.
func linuxSourceDescription(path CapturePath, s sourceSpec) string {
	size := ""
	if s.width > 0 && s.height > 0 {
		size = fmt.Sprintf(",width=%d,height=%d", s.width, s.height)
	}
	var src string
	if s.testPattern != "" {
		w, h := max(s.width, 1280), max(s.height, 720)
		src = fmt.Sprintf("videotestsrc name=%s is-live=true pattern=%s ! video/x-raw,format=BGRx,width=%d,height=%d,framerate=%d/1",
			sourceElementName, s.testPattern, w, h, s.fps)
	} else {
		caps := fmt.Sprintf("video/x-raw(memory:DMABuf),max-framerate=%d/1%s", s.fps, size)
		if s.shm || path == PathCPU {
			caps = fmt.Sprintf("video/x-raw,format=BGRx,max-framerate=%d/1%s", s.fps, size)
		}
		src = fmt.Sprintf("pipewiresrc name=%s fd=%d target-object=%d do-timestamp=true keepalive-time=1000 resend-last=true ! %s",
			sourceElementName, s.fd, s.serial, caps)
	}
	return src + fmt.Sprintf(" ! proxysink name=%s", captureSinkName)
}

// audioMuteName is the volume element that mutes the app audio while the curtain is on.
const audioMuteName = "amute"

// audioPipelineDescription is the app-audio pipeline: the raw PCM from fd goes through a
// mute (the curtain), into a mixer that also takes a live silence source, then Opus. The
// silence keeps 20 ms Opus frames (and the RTP track) flowing while the curtain mutes the
// app or the app plays nothing, so viewers never renegotiate.
func audioPipelineDescription(fd int, rate, channels int, sink string) string {
	return fmt.Sprintf("audiomixer name=amix ! opusenc bitrate=128000 frame-size=20 audio-type=generic "+
		"! appsink name=%s emit-signals=true sync=false max-buffers=16 drop=false "+
		"fdsrc name=asrc fd=%d do-timestamp=true blocksize=3840 "+
		"! rawaudioparse use-sink-caps=false format=pcm pcm-format=s16le sample-rate=%d num-channels=%d "+
		"! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 "+
		"! volume name=%s mute=false ! amix. "+
		"audiotestsrc wave=silence is-live=true samplesperbuffer=960 ! audio/x-raw,rate=48000,channels=2 ! amix.",
		sink, fd, rate, channels, audioMuteName)
}
