// SPDX-License-Identifier: AGPL-3.0-only

//go:build !nogst && !darwin

package media

import (
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"time"

	"github.com/go-gst/go-gst/pkg/gst"
	"github.com/go-gst/go-gst/pkg/gstapp"
	"github.com/go-gst/go-gst/pkg/gstvideo"
)

// vaBitrateGap is the shortest time between two bitrate changes on a VA-API encoder.
//
// vah264enc (and vah264lpenc) apply a new bitrate by draining and reconfiguring, which
// resets the GOP: every change is an IDR (gst-plugins-bad 1.28 sys/va: set_property sets
// reconf, handle_frame calls gst_va_base_enc_reset and the h264 reset_state sets
// cur_frame_index to 0). NVENC and x264 change it in place, so only VA is gated.
const vaBitrateGap = 3 * time.Second

// drainTimeout bounds how long Stop waits for the encoders to finish their frames.
const drainTimeout = 2 * time.Second

// collectDelay is how long after a Stop the Go collector runs (collectSoon).
const collectDelay = time.Second

// gstStream is what every GStreamer backend shares: one appsink and one encoder per
// simulcast layer, an optional Opus appsink, live bitrate changes and forced IDRs.
type gstStream struct {
	encoder  Encoder
	sinks    map[string]gstapp.AppSink
	encoders map[string]gst.Element
	// gates space out the bitrate changes of VA-API encoders (each one is an IDR).
	gates map[string]*bitrateGate
	// pipelines are set to NULL by Stop, in order.
	pipelines []gst.Pipeline

	video, audio chan EncodedFrame
	errs         chan error
	done         chan struct{}
	stopOnce     sync.Once
	// onStop runs after the pipelines are down and before the channels close.
	onStop []func()
	// detach disconnects the signal handlers and removes the pad probes whose Go closures
	// hold this stream; Stop runs it once the pipelines are down (see release).
	detach []func()
	// tap, when set, sees every video frame before it is queued (streaming thread).
	tap func(EncodedFrame)
	// thumbs holds the newest JPEG of the encoder input (nil without the branch).
	thumbs gstapp.AppSink
	// log, when set, reports an encoder that did not drain in time.
	log *slog.Logger
}

func newGstStream(enc Encoder, audio bool) *gstStream {
	s := &gstStream{
		encoder:  enc,
		sinks:    map[string]gstapp.AppSink{},
		encoders: map[string]gst.Element{},
		gates:    map[string]*bitrateGate{},
		video:    make(chan EncodedFrame, 64),
		errs:     make(chan error, 1),
		done:     make(chan struct{}),
	}
	if audio {
		s.audio = make(chan EncodedFrame, 64)
	}
	return s
}

// attachLayers finds each layer's encoder and appsink in the pipeline and connects them.
func (s *gstStream) attachLayers(pipeline gst.Pipeline, layers []Layer) error {
	for _, l := range layers {
		sink, ok := pipeline.GetByName(videoSinkName(l.RID)).(gstapp.AppSink)
		if !ok {
			return fmt.Errorf("%s is not an appsink", videoSinkName(l.RID))
		}
		s.sinks[l.RID] = sink
		enc := pipeline.GetByName(encoderName(l.RID))
		s.encoders[l.RID] = enc
		if s.encoder.IsVA() && enc != nil {
			s.gates[l.RID] = newBitrateGate(vaBitrateGap, l.Kbps, func(kbps int) {
				if !s.stopped() {
					enc.SetObjectProperty("bitrate", uint32(kbps))
				}
			})
		}
		s.connect(sink, l.RID, time.Second/time.Duration(l.FPS), s.video)
	}
	return nil
}

// attachThumbnail finds the thumbnail branch's appsink, when the pipeline has one.
func (s *gstStream) attachThumbnail(pipeline gst.Pipeline) {
	if sink, ok := pipeline.GetByName(thumbSinkName).(gstapp.AppSink); ok {
		s.thumbs = sink
	}
}

// Snapshot is the newest JPEG of the encoder input (internal/thumbnail), or false when no
// frame came since the last one was taken. It never blocks.
func (s *gstStream) Snapshot() ([]byte, bool) {
	if s.thumbs == nil || s.stopped() {
		return nil, false
	}
	sample := s.thumbs.TryPullSample(0)
	if sample == nil {
		return nil, false
	}
	buf := sample.GetBuffer()
	if buf == nil {
		return nil, false
	}
	m, ok := buf.Map(gst.MapRead)
	if !ok {
		return nil, false
	}
	defer m.Unmap()
	return append([]byte(nil), m.Data()...), true
}

// attachAudio connects the Opus appsink.
func (s *gstStream) attachAudio(pipeline gst.Pipeline) error {
	sink, ok := pipeline.GetByName(audioSinkName).(gstapp.AppSink)
	if !ok {
		return fmt.Errorf("%s is not an appsink", audioSinkName)
	}
	s.connect(sink, "", 20*time.Millisecond, s.audio)
	return nil
}

// Encoder is the concrete encoder the stream uses (auto resolved).
func (s *gstStream) Encoder() Encoder { return s.encoder }

func (s *gstStream) Video() <-chan EncodedFrame { return s.video }

func (s *gstStream) Audio() <-chan EncodedFrame {
	if s.audio == nil {
		return nil
	}
	return s.audio
}

func (s *gstStream) Err() <-chan error { return s.errs }

// fail reports a fatal error once; later ones are dropped.
func (s *gstStream) fail(err error) {
	select {
	case s.errs <- err:
	default:
	}
}

// stopped reports whether Stop has begun.
func (s *gstStream) stopped() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

// connect copies every sample of an appsink into out. It runs on the branch's streaming
// thread and blocks when out is full (a live source then drops raw frames upstream,
// never encoded ones, which would break decoding until the next IDR).
func (s *gstStream) connect(sink gstapp.AppSink, rid string, duration time.Duration, out chan<- EncodedFrame) {
	h := sink.ConnectNewSample(func(sink gstapp.AppSink) gst.FlowReturn {
		sample := sink.PullSample()
		if sample == nil {
			return gst.FlowEOS
		}
		buf := sample.GetBuffer()
		if buf == nil {
			return gst.FlowError
		}
		m, ok := buf.Map(gst.MapRead)
		if !ok {
			return gst.FlowError
		}
		data := append([]byte(nil), m.Data()...)
		m.Unmap()
		f := EncodedFrame{RID: rid, Data: data, Duration: duration, Keyframe: !buf.HasFlags(gst.BufferFlagDeltaUnit)}
		if pts := buf.PTS(); pts != gst.ClockTimeNone {
			f.PTS = time.Duration(pts)
		}
		if s.tap != nil && rid != "" {
			s.tap(f)
		}
		select {
		case out <- f:
		case <-s.done:
			// Stopping: drop the frame but keep the encoder going, so it can drain (Stop).
		}
		return gst.FlowOK
	})
	s.detach = append(s.detach, func() { sink.HandlerDisconnect(h) })
}

// addProbe adds a pad probe that Stop removes again (see release).
func (s *gstStream) addProbe(pad gst.Pad, mask gst.PadProbeType, fn gst.PadProbeCallback) {
	id := pad.AddProbe(mask, fn)
	s.detach = append(s.detach, func() { pad.RemoveProbe(id) })
}

// watchBus turns the pipeline's bus messages into a stream error. classify maps an error
// message to the error reported (nil: ignore it); warnings go to warn when set.
func (s *gstStream) watchBus(pipeline gst.Pipeline, classify func(*gst.Message) error, warn func(string)) {
	bus := pipeline.GetBus()
	for {
		if s.stopped() {
			return
		}
		msg := bus.TimedPop(gst.ClockTime(100 * time.Millisecond))
		if msg == nil {
			continue
		}
		var err error
		switch msg.Type() {
		case gst.MessageError:
			err = classify(msg)
		case gst.MessageEOS:
			err = fmt.Errorf("gstreamer: end of stream")
		case gst.MessageWarning:
			if warn != nil {
				debug, gerr := msg.ParseWarning()
				warn(fmt.Sprintf("%s: %v (%s)", msg.Source().GetName(), gerr, debug))
			}
		}
		if err != nil {
			s.fail(err)
			return
		}
	}
}

// gstError is the default classify for watchBus.
func gstError(msg *gst.Message) error {
	debug, gerr := msg.ParseError()
	return fmt.Errorf("gstreamer: %v (%s)", gerr, debug)
}

// SetBitrate changes one encoder's bitrate while PLAYING. nvh264enc reconfigures NVENC in
// place and x264enc calls x264_encoder_reconfig; neither restarts or emits an IDR. The
// VBV size is left alone. vah264enc restarts its GOP on every change, so its
// changes are spaced out (bitrateGate).
func (s *gstStream) SetBitrate(rid string, kbps int) error {
	enc, ok := s.encoders[rid]
	if !ok || enc == nil {
		return fmt.Errorf("no layer %q", rid)
	}
	if kbps <= 0 {
		return fmt.Errorf("bitrate must be positive")
	}
	if g := s.gates[rid]; g != nil {
		g.set(kbps)
		return nil
	}
	enc.SetObjectProperty("bitrate", uint32(kbps))
	return nil
}

// RequestKeyframe sends an upstream force-key-unit event from the layer's appsink;
// h264parse passes it to the encoder, and with all-headers SPS/PPS precede the IDR.
func (s *gstStream) RequestKeyframe(rid string) error {
	sink, ok := s.sinks[rid]
	if !ok {
		return fmt.Errorf("no layer %q", rid)
	}
	if !sink.SendEvent(gstvideo.VideoEventNewUpstreamForceKeyUnit(gst.ClockTimeNone, true, 0)) {
		return fmt.Errorf("layer %s: force-key-unit event not handled", rid)
	}
	return nil
}

// Stop drains the encoders, tears the pipelines down and closes the channels.
//
// An NVENC session must not be destroyed while it still has frames in flight: its
// completion thread (in libnvcuvid) outlives the session and reads the freed session
// memory, a SIGSEGV seconds later. Going straight to NULL flushes, which drops
// those frames; EOS makes the encoder wait for each of them first.
func (s *gstStream) Stop() error {
	s.stopOnce.Do(func() {
		close(s.done)
		for _, g := range s.gates {
			g.close()
		}
		s.drain(drainTimeout)
		for _, p := range s.pipelines {
			p.SetState(gst.StateNull)
			if _, _, r := p.GetState(gst.ClockTime(drainTimeout)); r == gst.StateChangeFailure && s.log != nil {
				s.log.Warn("a pipeline did not stop cleanly", "pipeline", p.GetName())
			}
		}
		for _, f := range s.onStop {
			f()
		}
		s.release()
		close(s.video)
		if s.audio != nil {
			close(s.audio)
		}
		close(s.errs)
		collectSoon()
	})
	return nil
}

// release lets the stopped pipelines be freed. go-gst keeps the Go function of every
// signal handler and pad probe in a global registry until GStreamer drops the closure,
// and GStreamer drops it only when the handler is disconnected or its object finalized.
// Those functions hold this stream, which holds Go references (and with them GStreamer
// references) to the pipelines and their elements: a cycle through C that the Go
// collector cannot see, so no pipeline was ever freed. Each one kept its elements and
// the GstContexts they share, the GL display and the CUDA context, with their threads
// and ~240 MiB of VRAM for a three-layer NVENC stream. Disconnecting breaks the
// cycle; the references go when the collector finalizes the wrappers (collectSoon).
func (s *gstStream) release() {
	for _, f := range s.detach {
		f()
	}
	s.detach = nil
}

var collect struct {
	sync.Mutex
	pending, again bool
}

// collectSoon runs the Go collector collectDelay from now. A stop never postpones the
// collection an earlier one asked for; when one is already due, another follows it.
//
// Only the collector gives a stopped pipeline back to GStreamer: every Go wrapper holds a
// reference, dropped by its finalizer. An idle helper allocates next to nothing, so
// without this the GL display, the CUDA context and their VRAM stayed until Go's forced
// collection, up to two minutes after the stream ended. The delay lets the caller drop
// the stream and its goroutines (bus watches, control) end first.
func collectSoon() {
	collect.Lock()
	defer collect.Unlock()
	if collect.pending {
		collect.again = true
		return
	}
	collect.pending = true
	time.AfterFunc(collectDelay, func() {
		runtime.GC()
		collect.Lock()
		collect.pending = false
		again := collect.again
		collect.again = false
		collect.Unlock()
		if again {
			collectSoon()
		}
	})
}

// drain sends EOS into every encoder and waits, at most timeout, until each has handled
// it: a video encoder handles EOS by finishing every frame it holds (nvh264enc waits for
// NVENC's pending outputs), and sending the event returns once that is done. Frames the
// encoders still produce are dropped (connect).
func (s *gstStream) drain(timeout time.Duration) {
	done := make(chan struct{}, len(s.encoders))
	n := 0
	for _, enc := range s.encoders {
		if enc == nil {
			continue
		}
		pad := enc.GetStaticPad("sink")
		if pad == nil {
			continue
		}
		n++
		go func() {
			pad.SendEvent(gst.NewEventEOS())
			done <- struct{}{}
		}()
	}
	deadline := time.After(timeout)
	for ; n > 0; n-- {
		select {
		case <-done:
		case <-deadline:
			if s.log != nil {
				s.log.Warn("encoders did not drain in time; stopping them anyway", "timeout", timeout, "pending", n)
			}
			return
		}
	}
}

// play sets a pipeline to PLAYING, or to NULL again when that fails.
func play(p gst.Pipeline) error {
	if p.SetState(gst.StatePlaying) == gst.StateChangeFailure {
		p.SetState(gst.StateNull)
		return fmt.Errorf("pipeline did not start")
	}
	return nil
}

// parsePipeline parses a gst-launch description that must yield a pipeline.
func parsePipeline(desc string) (gst.Pipeline, error) {
	el, err := gst.ParseLaunch(desc)
	if err != nil {
		return nil, fmt.Errorf("parse pipeline: %w", err)
	}
	pipeline, ok := el.(gst.Pipeline)
	if !ok {
		return nil, fmt.Errorf("parse pipeline: not a pipeline")
	}
	return pipeline, nil
}
