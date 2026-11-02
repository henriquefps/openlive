// SPDX-License-Identifier: AGPL-3.0-only

//go:build !nogst && !darwin

package media

import (
	"bytes"
	"context"
	"image/jpeg"
	"runtime"
	"sync"
	"testing"
	"time"
	"weak"

	"github.com/go-gst/go-gst/pkg/gst"
)

// TestTestPipeline runs the real GStreamer test pipeline with x264 for 2 s: every layer
// produces frames near its rate, the first frame of each layer is a keyframe, a forced
// keyframe comes out, and live bitrate changes are accepted.
func TestTestPipeline(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test: runs GStreamer for 2 s")
	}
	for _, el := range []string{"videotestsrc", "x264enc", "h264parse", "timeoverlay", "textoverlay", "audiotestsrc", "opusenc", "appsink"} {
		if !HasElement(el) {
			t.Skipf("GStreamer element %s not available", el)
		}
	}
	preset, err := FindPreset("1080p30")
	if err != nil {
		t.Fatal(err)
	}
	layers, err := preset.Layers([]string{"f", "h", "q"})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := NewTestBackend()
	s, err := b.Start(context.Background(), Source{ID: "test"}, Profile{Layers: layers, Encoder: EncoderX264, Audio: true, GOP: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Stop() }()

	frames := map[string]int{}
	keyframes := map[string]int{}
	firstKey := map[string]bool{}
	firstAt := map[string]time.Time{}
	audio := 0
	const run = 2 * time.Second
	end := time.Now().Add(run)
	deadline := time.After(run)
	forceAt := time.After(run / 2)
	forced := false
loop:
	for {
		select {
		case f := <-s.Video():
			if frames[f.RID] == 0 {
				firstKey[f.RID] = f.Keyframe
				firstAt[f.RID] = time.Now()
			}
			frames[f.RID]++
			if f.Keyframe {
				keyframes[f.RID]++
			}
		case f := <-s.Audio():
			if len(f.Data) > 0 {
				audio++
			}
		case <-forceAt:
			for _, l := range layers {
				if err := s.RequestKeyframe(l.RID); err != nil {
					t.Errorf("RequestKeyframe(%s): %v", l.RID, err)
				}
				if err := s.SetBitrate(l.RID, l.Kbps/2); err != nil {
					t.Errorf("SetBitrate(%s): %v", l.RID, err)
				}
			}
			forced = true
		case err := <-s.Err():
			if err != nil {
				t.Fatal(err)
			}
		case <-deadline:
			break loop
		}
	}
	if !forced {
		t.Fatal("keyframe was never forced")
	}
	for _, l := range layers {
		// Rate from the layer's first frame, so encoder start-up does not count.
		fps := float64(frames[l.RID]-1) / end.Sub(firstAt[l.RID]).Seconds()
		t.Logf("layer %s %dx%d: %d frames (%.1f fps, want %d), %d keyframes", l.RID, l.Width, l.Height, frames[l.RID], fps, l.FPS, keyframes[l.RID])
		if fps < float64(l.FPS)*0.6 {
			t.Errorf("layer %s: %.1f fps, want about %d", l.RID, fps, l.FPS)
		}
		if !firstKey[l.RID] {
			t.Errorf("layer %s: first frame is not a keyframe", l.RID)
		}
		if keyframes[l.RID] < 2 {
			t.Errorf("layer %s: %d keyframes, want the first one plus the forced one", l.RID, keyframes[l.RID])
		}
	}
	t.Logf("audio: %d Opus packets", audio)
	if audio < 50 {
		t.Errorf("audio: %d Opus packets in %v, want about 100", audio, run)
	}
}

// TestTestPipelineSnapshot takes the thumbnail branch's JPEG while the
// encoders keep producing: a 320 px frame, small, at most one per 2 s.
func TestTestPipelineSnapshot(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test: runs GStreamer for 3 s")
	}
	for _, el := range []string{"videotestsrc", "x264enc", "jpegenc", "videorate", "appsink"} {
		if !HasElement(el) {
			t.Skipf("GStreamer element %s not available", el)
		}
	}
	preset, _ := FindPreset("1080p30")
	layers, _ := preset.Layers([]string{"f"})
	b, _ := NewTestBackend()
	s, err := b.Start(context.Background(), Source{ID: "test"}, Profile{Layers: layers, Encoder: EncoderX264, GOP: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Stop() }()
	snap, ok := s.(interface{ Snapshot() ([]byte, bool) })
	if !ok {
		t.Fatal("the test stream has no Snapshot")
	}
	frames := 0
	var jpegData []byte
	deadline := time.After(3 * time.Second)
loop:
	for {
		select {
		case <-s.Video():
			frames++
			if data, ok := snap.Snapshot(); ok {
				jpegData = data
			}
		case <-deadline:
			break loop
		}
	}
	if frames < 60 {
		t.Fatalf("the encoder produced %d frames in 3 s with the thumbnail branch", frames)
	}
	if jpegData == nil {
		t.Fatal("no snapshot in 3 s")
	}
	img, err := jpeg.Decode(bytes.NewReader(jpegData))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 320 || b.Dy() != 180 || len(jpegData) > 30*1024 {
		t.Fatalf("snapshot %v, %d bytes", b, len(jpegData))
	}
	// Taken: nothing new until the branch's next frame.
	if _, ok := snap.Snapshot(); ok {
		t.Fatal("the same snapshot twice")
	}
}

// TestStopDrainsEncoders: Stop sends EOS through every encoder before the pipeline goes
// to NULL (an NVENC session destroyed with frames in flight crashed the process),
// and does it quickly even when nobody reads the frames any more.
func TestStopDrainsEncoders(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test: runs GStreamer")
	}
	for _, el := range []string{"videotestsrc", "x264enc", "h264parse", "timeoverlay", "textoverlay", "appsink"} {
		if !HasElement(el) {
			t.Skipf("GStreamer element %s not available", el)
		}
	}
	preset, _ := FindPreset("1080p30")
	layers, _ := preset.Layers([]string{"f", "h", "q"})
	b, _ := NewTestBackend()
	st, err := b.Start(context.Background(), Source{ID: "test"}, Profile{Layers: layers, Encoder: EncoderX264, GOP: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	s := st.(*TestStream)
	var eos sync.Map
	for rid, sink := range s.sinks {
		sink.GetStaticPad("sink").AddProbe(gst.PadProbeTypeEventDownstream, func(_ gst.Pad, info *gst.PadProbeInfo) gst.PadProbeReturn {
			if ev := info.GetEvent(); ev != nil && ev.GetType() == gst.EventEOS {
				eos.Store(rid, true)
			}
			return gst.PadProbeOK
		})
	}
	// Nobody reads: the frame channel fills up and the appsinks block on it.
	time.Sleep(time.Second)
	t0 := time.Now()
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(t0); d > drainTimeout {
		t.Errorf("Stop took %s, want under %s", d, drainTimeout)
	}
	for _, l := range layers {
		if _, ok := eos.Load(l.RID); !ok {
			t.Errorf("layer %s: no EOS reached the appsink before NULL", l.RID)
		}
	}
	for range s.Video() {
	}
}

// TestStopFreesTheStream: once stopped and dropped, a stream can be collected. Its signal
// handlers and pad probes used to keep it, and through it every pipeline, alive for the
// life of the process (go-gst holds their Go functions until GStreamer drops the closure),
// with the GL display, CUDA context and VRAM of an NVENC stream.
func TestStopFreesTheStream(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test: runs GStreamer")
	}
	for _, el := range []string{"videotestsrc", "x264enc", "h264parse", "timeoverlay", "textoverlay", "audiotestsrc", "opusenc", "appsink"} {
		if !HasElement(el) {
			t.Skipf("GStreamer element %s not available", el)
		}
	}
	preset, _ := FindPreset("1080p30")
	layers, _ := preset.Layers([]string{"f", "h", "q"})
	// The stream is only reachable inside run, as a caller drops it after Stop.
	run := func() weak.Pointer[gstStream] {
		b, _ := NewTestBackend()
		st, err := b.Start(context.Background(), Source{ID: "test"}, Profile{Layers: layers, Encoder: EncoderX264, Audio: true, GOP: 10 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		s := st.(*TestStream)
		go func() {
			for range s.Audio() {
			}
		}()
		for range 5 {
			<-s.Video()
		}
		if err := s.Stop(); err != nil {
			t.Fatal(err)
		}
		if len(s.detach) != 0 {
			t.Errorf("%d handlers or probes left after Stop", len(s.detach))
		}
		return weak.Make(s.gstStream)
	}
	gone := run()
	// The bus watch ends within one poll (100 ms).
	deadline := time.Now().Add(3 * time.Second)
	for gone.Value() != nil {
		if time.Now().After(deadline) {
			t.Fatal("the stopped stream is still reachable")
		}
		runtime.GC()
		time.Sleep(50 * time.Millisecond)
	}
}
