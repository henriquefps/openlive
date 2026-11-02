// SPDX-License-Identifier: AGPL-3.0-only

//go:build !nogst && !darwin

package media

import (
	"context"
	"sync"
	"time"

	"github.com/go-gst/go-gst/pkg/gst"
)

// GStreamerAvailable is true in builds with GStreamer (without the nogst tag).
const GStreamerAvailable = true

var initOnce sync.Once

func initGst() { initOnce.Do(func() { gst.Init() }) }

// GStreamerVersion is the version of the GStreamer library in use.
func GStreamerVersion() string {
	initGst()
	return gst.VersionString()
}

// HasElement reports whether GStreamer has an element factory with that name.
func HasElement(name string) bool {
	initGst()
	return gst.ElementFactoryFind(name) != nil
}

// TestBackend is the synthetic source: no capture, a generated pattern with a clock
// (row "Teste/CI").
type TestBackend struct{}

// NewTestBackend returns the test backend.
func NewTestBackend() (*TestBackend, error) { return &TestBackend{}, nil }

// ListSources returns the one test pattern.
func (*TestBackend) ListSources(context.Context) ([]Source, error) {
	return []Source{{ID: "test", Kind: SourceTest, Label: "Test pattern"}}, nil
}

// Start builds and plays the test pipeline.
func (*TestBackend) Start(_ context.Context, _ Source, p Profile) (Stream, error) {
	initGst()
	enc, err := ResolveEncoder(p.Encoder, HasElement)
	if err != nil {
		return nil, err
	}
	if HasAV1(p.Layers) {
		if _, err := ResolveAV1(enc, HasElement); err != nil {
			return nil, err
		}
	}
	desc, err := testPipelineDescription(p.Layers, enc, p.GOP, p.Audio)
	if err != nil {
		return nil, err
	}
	pipeline, err := parsePipeline(desc)
	if err != nil {
		return nil, err
	}
	s := &TestStream{gstStream: newGstStream(enc, p.Audio)}
	s.pipelines = []gst.Pipeline{pipeline}
	if err := s.attachLayers(pipeline, p.Layers); err != nil {
		s.release()
		return nil, err
	}
	s.attachThumbnail(pipeline)
	if p.Audio {
		s.tone = pipeline.GetByName(toneName)
		if err := s.attachAudio(pipeline); err != nil {
			s.release()
			return nil, err
		}
	}
	s.drawClock(pipeline.GetByName(clockOverlayName))

	if err := play(pipeline); err != nil {
		s.release()
		return nil, err
	}
	go s.watchBus(pipeline, gstError, nil)
	return s, nil
}

// TestStream is a running test pipeline.
type TestStream struct {
	*gstStream
	tone gst.Element
}

// drawClock sets the overlay's text to the wall clock right before each frame passes.
func (s *TestStream) drawClock(overlay gst.Element) {
	if overlay == nil {
		return
	}
	pad := overlay.GetStaticPad("video_sink")
	if pad == nil {
		return
	}
	s.addProbe(pad, gst.PadProbeTypeBuffer, func(gst.Pad, *gst.PadProbeInfo) gst.PadProbeReturn {
		overlay.SetObjectProperty("text", time.Now().Format(ClockFormat))
		return gst.PadProbeOK
	})
}

// SetTone turns the 440 Hz test tone on or off without renegotiating (the audio track
// keeps sending, silent).
func (s *TestStream) SetTone(on bool) {
	if s.tone == nil {
		return
	}
	volume := 0.0
	if on {
		volume = 0.2
	}
	s.tone.SetObjectProperty("volume", volume)
}
