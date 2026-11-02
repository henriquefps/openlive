// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux && !nogst

package media

import (
	"encoding/binary"
	"math"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-gst/go-gst/pkg/gst"
	"github.com/go-gst/go-gst/pkg/gstapp"

	"github.com/henriquefps/openlive/helper/internal/audio"
)

// TestAudioPipelineCurtain runs the app-audio pipeline on a loud PCM tone from a pipe:
// with the mute on, the Opus frames keep coming (the track never stops) but shrink to
// silence; when it lifts the tone is back at once. With no PCM at all, silence still flows.
func TestAudioPipelineCurtain(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test: runs GStreamer for several seconds")
	}
	for _, el := range []string{"audiomixer", "audiotestsrc", "volume", "opusenc", "appsink", "fdsrc", "rawaudioparse"} {
		if !HasElement(el) {
			t.Skipf("GStreamer element %s not available", el)
		}
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	var feeding atomic.Bool
	var stopFeed atomic.Bool
	go func() {
		defer func() { _ = w.Close() }()
		chunk := make([]byte, 3840) // 20 ms of s16le stereo
		for i := 0; !stopFeed.Load(); i++ {
			time.Sleep(20 * time.Millisecond)
			if !feeding.Load() {
				continue
			}
			for n := 0; n < len(chunk)/4; n++ {
				v := int16(20000 * math.Sin(2*math.Pi*440*float64(i*960+n)/48000))
				binary.LittleEndian.PutUint16(chunk[n*4:], uint16(v))
				binary.LittleEndian.PutUint16(chunk[n*4+2:], uint16(v))
			}
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}()
	defer stopFeed.Store(true)

	initGst()
	p, err := parsePipeline(audioPipelineDescription(int(r.Fd()), audio.SampleRate, audio.Channels, audioSinkName))
	if err != nil {
		t.Fatal(err)
	}
	if err := play(p); err != nil {
		t.Fatal(err)
	}
	defer p.SetState(gst.StateNull)
	sink := p.GetByName(audioSinkName).(gstapp.AppSink)
	mute := p.GetByName(audioMuteName)
	if mute == nil {
		t.Fatalf("no %s element", audioMuteName)
	}

	// avg is the mean Opus frame size over d, and how many frames came.
	avg := func(d time.Duration) (float64, int) {
		end := time.Now().Add(d)
		total, n := 0, 0
		for time.Now().Before(end) {
			sample := sink.TryPullSample(gst.ClockTime(50 * time.Millisecond))
			if sample == nil {
				continue
			}
			total += int(sample.GetBuffer().GetSize())
			n++
		}
		if n == 0 {
			return 0, 0
		}
		return float64(total) / float64(n), n
	}

	// No app audio at all: silence frames flow anyway.
	avg(500 * time.Millisecond)
	if _, n := avg(time.Second); n < 30 {
		t.Fatalf("%d frames in 1 s without app audio, want ~50", n)
	}
	feeding.Store(true)
	avg(500 * time.Millisecond)
	loud, n := avg(time.Second)
	if n < 30 {
		t.Fatalf("%d frames with app audio, want ~50", n)
	}
	mute.SetObjectProperty("mute", true)
	avg(300 * time.Millisecond) // frames already in flight
	quiet, n := avg(time.Second)
	if n < 30 {
		t.Fatalf("%d frames while muted: the track stopped, want ~50", n)
	}
	if quiet*3 > loud {
		t.Errorf("muted frames average %.1f bytes, loud ones %.1f: not silent", quiet, loud)
	}
	mute.SetObjectProperty("mute", false)
	avg(300 * time.Millisecond)
	back, _ := avg(time.Second)
	if back < loud/2 {
		t.Errorf("after the curtain the frames average %.1f bytes, want near %.1f", back, loud)
	}
}
