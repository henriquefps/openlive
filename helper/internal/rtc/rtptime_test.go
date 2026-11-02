// SPDX-License-Identifier: AGPL-3.0-only

package rtc

import (
	"log/slog"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/henriquefps/openlive/helper/internal/media"
)

// fakeTrackContext binds a TrackLocalStaticSample to a writer that keeps the packets.
type fakeTrackContext struct{ w *packetLog }

func (c fakeTrackContext) CodecParameters() []webrtc.RTPCodecParameters {
	return []webrtc.RTPCodecParameters{{RTPCodecCapability: videoCapability(media.CodecH264), PayloadType: 96}}
}
func (fakeTrackContext) HeaderExtensions() []webrtc.RTPHeaderExtensionParameter { return nil }
func (fakeTrackContext) SSRC() webrtc.SSRC                                      { return 1 }
func (fakeTrackContext) SSRCRetransmission() webrtc.SSRC                        { return 0 }
func (fakeTrackContext) SSRCForwardErrorCorrection() webrtc.SSRC                { return 0 }
func (c fakeTrackContext) WriteStream() webrtc.TrackLocalWriter                 { return c.w }
func (fakeTrackContext) ID() string                                             { return "fake" }
func (fakeTrackContext) RTCPReader() interceptor.RTCPReader                     { return nil }

type packetLog struct{ stamps []uint32 }

func (l *packetLog) WriteRTP(h *rtp.Header, p []byte) (int, error) {
	l.stamps = append(l.stamps, h.Timestamp)
	return len(p), nil
}
func (l *packetLog) Write(b []byte) (int, error) { return len(b), nil }

// The RTP timestamp of each frame is the real time since the layer's first frame, before
// the frame goes out: a frame after a still screen carries the time it was captured, not
// the previous frame's time plus 1/fps.
func TestWriteVideoFollowsRealTime(t *testing.T) {
	track, err := webrtc.NewTrackLocalStaticSample(videoCapability(media.CodecH264), "video", "s")
	if err != nil {
		t.Fatal(err)
	}
	log := &packetLog{}
	if _, err := track.Bind(fakeTrackContext{w: log}); err != nil {
		t.Fatal(err)
	}
	p := &Publisher{log: slog.Default(), clocks: map[string]*media.FrameClock{}}
	t0 := time.Unix(1000, 0)
	idr := []byte{0, 0, 0, 1, 0x65, 0x88, 0x84}
	// 60 fps for one second, then a still screen: frames 3 s and 30 s later.
	var at []time.Duration
	for i := 0; i < 60; i++ {
		at = append(at, time.Duration(i)*time.Second/60)
	}
	at = append(at, 4*time.Second, 34*time.Second, 34*time.Second+time.Second/60)
	for _, d := range at {
		// Linux sends the nominal 1/60 s whatever the real spacing; it must not matter.
		p.writeVideoSample(track, media.EncodedFrame{RID: "f", Data: idr, PTS: 5*time.Second + d, Duration: time.Second / 60}, t0.Add(d))
	}
	if len(log.stamps) != len(at) {
		t.Fatalf("%d packets for %d frames", len(log.stamps), len(at))
	}
	for i, d := range at {
		got := int64(log.stamps[i] - log.stamps[0])
		want := int64(d.Seconds() * 90000)
		if got < want-1 || got > want+1 {
			t.Errorf("frame %d at %s: RTP +%d, want +%d", i, d, got, want)
		}
	}
}
