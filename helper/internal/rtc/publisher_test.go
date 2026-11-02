// SPDX-License-Identifier: AGPL-3.0-only

package rtc

import (
	"context"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/henriquefps/openlive/helper/internal/media"
)

func TestRIDStamperWritesBothExtensions(t *testing.T) {
	s := newRIDStamper()
	s.set(1111, "h")
	s.setMid(1111, "0")
	info := &interceptor.StreamInfo{SSRC: 1111, RTPHeaderExtensions: []interceptor.RTPHeaderExtension{
		{URI: uriMID, ID: 4}, {URI: uriRID, ID: 10}, {URI: "urn:ietf:params:rtp-hdrext:ssrc-audio-level", ID: 1},
	}}
	var got rtp.Header
	w := s.BindLocalStream(info, interceptor.RTPWriterFunc(func(h *rtp.Header, _ []byte, _ interceptor.Attributes) (int, error) {
		got = *h
		return 0, nil
	}))
	if _, err := w.Write(&rtp.Header{Version: 2, SSRC: 1111}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if rid := string(got.GetExtension(10)); rid != "h" {
		t.Errorf("rtp-stream-id = %q, want h", rid)
	}
	if mid := string(got.GetExtension(4)); mid != "0" {
		t.Errorf("mid = %q, want 0", mid)
	}

	// Streams that are not simulcast encodings pass through untouched.
	plain := s.BindLocalStream(&interceptor.StreamInfo{SSRC: 2222, RTPHeaderExtensions: info.RTPHeaderExtensions},
		interceptor.RTPWriterFunc(func(h *rtp.Header, _ []byte, _ interceptor.Attributes) (int, error) {
			got = *h
			return 0, nil
		}))
	if _, err := plain.Write(&rtp.Header{Version: 2, SSRC: 2222}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got.Extension {
		t.Errorf("unknown SSRC got header extensions: %+v", got.Extensions)
	}
}

// fakeStream produces fake H.264 access units for each layer and records the controls.
type fakeStream struct {
	video chan media.EncodedFrame
	audio chan media.EncodedFrame
	// silent is an audio channel nobody writes to (newSilentAppStream).
	silent chan media.EncodedFrame
	errs   chan error
	stop   chan struct{}
	once   sync.Once

	mu        sync.Mutex
	keyframes map[string]int
	bitrates  map[string]int
}

func newFakeStream(layers []media.Layer, audio bool) *fakeStream {
	s := &fakeStream{
		video: make(chan media.EncodedFrame, 16), errs: make(chan error), stop: make(chan struct{}),
		keyframes: map[string]int{}, bitrates: map[string]int{},
	}
	if audio {
		s.audio = make(chan media.EncodedFrame, 16)
	}
	s.run(layers)
	return s
}

// newSilentAppStream has an audio channel that never carries a frame: an app that plays
// nothing while its window is shared.
func newSilentAppStream(layers []media.Layer) *fakeStream {
	s := newFakeStream(layers, false)
	s.silent = make(chan media.EncodedFrame)
	return s
}

func (s *fakeStream) run(layers []media.Layer) {
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-tick.C:
			}
			for _, l := range layers {
				// Annex B: start code, IDR slice NAL header, a few payload bytes.
				data := []byte{0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, byte(len(l.RID))}
				select {
				case s.video <- media.EncodedFrame{RID: l.RID, Data: data, Keyframe: true, Duration: 20 * time.Millisecond}:
				case <-s.stop:
					return
				}
			}
			if s.audio != nil {
				select {
				case s.audio <- media.EncodedFrame{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}:
				case <-s.stop:
					return
				}
			}
		}
	}()
}

func (s *fakeStream) Video() <-chan media.EncodedFrame { return s.video }
func (s *fakeStream) Audio() <-chan media.EncodedFrame {
	if s.silent != nil {
		return s.silent
	}
	if s.audio == nil {
		return nil
	}
	return s.audio
}
func (s *fakeStream) Err() <-chan error { return s.errs }
func (s *fakeStream) Stop() error {
	s.once.Do(func() { close(s.stop) })
	return nil
}
func (s *fakeStream) SetBitrate(rid string, kbps int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bitrates[rid] = kbps
	return nil
}
func (s *fakeStream) RequestKeyframe(rid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keyframes[rid]++
	return nil
}
func (s *fakeStream) keyframeCount(rid string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.keyframes[rid]
}

// TestPublishSimulcastLoopback publishes three layers and audio to an in-process pion
// receiver: the receiver can only tell the layers apart through the rid/mid header
// extensions the stamper writes. A burst of PLIs on one layer then costs two IDRs
// (one at once, one coalesced at the end of the rate-limit window).
func TestPublishSimulcastLoopback(t *testing.T) {
	preset, _ := media.FindPreset("1080p60")
	layers, _ := preset.Layers(media.AllRIDs)
	stream := newFakeStream(layers, true)
	defer func() { _ = stream.Stop() }()
	sig, err := NewLoopback()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sig.Close() }()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pub, err := Publish(ctx, Config{
		Layers:           layers,
		Audio:            true,
		ICEServers:       []webrtc.ICEServer{},
		TrackPrefix:      "test",
		KeyframeInterval: 300 * time.Millisecond,
		// Below the layers' 12500 kbit/s: the encoders start capped, f absorbs the cut.
		Rate:          RateConfig{MaxKbps: 11872},
		Logger:        slog.New(slog.DiscardHandler),
		SettingEngine: LoopbackSettings(),
	}, stream, sig)
	if err != nil {
		t.Fatal(err)
	}
	stream.mu.Lock()
	f, h := stream.bitrates["f"], stream.bitrates["h"]
	stream.mu.Unlock()
	if f == 0 || f > 7372 || h != 0 {
		t.Fatalf("starting bitrates f=%d h=%d, want f ≤ 7372 (12500 capped to 11872) and h untouched", f, h)
	}
	if pub.SessionID() != "loopback-session" {
		t.Fatalf("session %q", pub.SessionID())
	}
	tracks := pub.Tracks()
	if len(tracks) != 2 || tracks[0].Name != "test-video" || len(tracks[0].Rids) != 3 || tracks[1].Kind != "audio" || tracks[0].Mid == "" {
		t.Fatalf("published tracks %+v", tracks)
	}

	// Wait until every layer and the audio arrive on their own receiver track.
	deadline := time.Now().Add(10 * time.Second)
	for {
		st := sig.Stats()
		ssrc, pkts := st.SSRC, st.Packets
		if len(ssrc) == 4 && pkts["f"] > 5 && pkts["h"] > 5 && pkts["q"] > 5 && pkts["audio"] > 5 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not every layer arrived: ssrc %v packets %v", ssrc, pkts)
		}
		time.Sleep(50 * time.Millisecond)
	}

	for range 3 {
		if err := sig.SendPLI("f"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	deadline = time.Now().Add(5 * time.Second)
	for stream.keyframeCount("f") < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(400 * time.Millisecond) // no further IDR may follow
	if n := stream.keyframeCount("f"); n != 2 {
		t.Fatalf("3 PLIs on f forced %d IDRs, want 2", n)
	}
	if n := stream.keyframeCount("h") + stream.keyframeCount("q"); n != 0 {
		t.Fatalf("PLI on f forced %d IDRs on other layers", n)
	}

	st := pub.Stats()
	if len(st.Layers) != 3 || st.Layers[0].Frames == 0 || st.AudioPackets == 0 || st.Layers[0].ForcedIDRs != 2 {
		t.Fatalf("stats %+v", st)
	}
	// The 3 PLIs are counted on f, from one requester (the loopback receiver).
	if f := st.Layers[0]; f.PLIs != 3 || f.FIRs != 0 || f.Requesters != 1 || st.Layers[1].PLIs != 0 {
		t.Fatalf("keyframe requests: f %d PLIs, %d FIRs, %d requesters; h %d PLIs", f.PLIs, f.FIRs, f.Requesters, st.Layers[1].PLIs)
	}
	if err := pub.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !sig.Unpublished() {
		t.Fatal("Close did not unpublish")
	}
}

// TestPublishAV1Track: with an AV1 layer the publication has a second video track,
// <prefix>-video-av1, carrying the top layer alone (no rids, codec av1) and offered with AV1
// only; its packets arrive, and a PLI on it forces an IDR on the AV1 encoder, not on f.
func TestPublishAV1Track(t *testing.T) {
	preset, _ := media.FindPreset("1080p60")
	h264, _ := preset.Layers(media.AllRIDs)
	layers := media.WithAV1(h264, media.AV1SavePercent)
	stream := newFakeStream(layers, true)
	defer func() { _ = stream.Stop() }()
	lb, err := NewLoopback()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lb.Close() }()
	sig := &offerRecorder{Loopback: lb}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pub, err := Publish(ctx, Config{
		Layers: layers, Audio: true, ICEServers: []webrtc.ICEServer{}, TrackPrefix: "test",
		KeyframeInterval: 300 * time.Millisecond,
		Logger:           slog.New(slog.DiscardHandler), SettingEngine: LoopbackSettings(),
	}, stream, sig)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pub.Close(context.Background()) }()
	tracks := pub.Tracks()
	if len(tracks) != 3 || tracks[0].Name != "test-video" || tracks[0].Codec != "" || len(tracks[0].Rids) != 3 ||
		tracks[1].Name != "test-video-av1" || tracks[1].Codec != "av1" || len(tracks[1].Rids) != 0 || tracks[2].Kind != "audio" {
		t.Fatalf("published tracks %+v", tracks)
	}
	// The AV1 m-section offers AV1 (and its RTX) only.
	sections := strings.Split(sig.offer, "m=")
	if len(sections) != 4 || !strings.Contains(sections[2], "AV1/90000") || strings.Contains(sections[2], "H264") || strings.Contains(sections[2], "VP8") {
		t.Fatalf("AV1 m-section:\n%s", sections[2])
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		pkts := lb.Stats().Packets
		if pkts["f"] > 5 && pkts["af"] > 5 && pkts["audio"] > 5 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not every track arrived: %v", pkts)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := lb.SendPLI("af"); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for stream.keyframeCount("af") < 1 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if stream.keyframeCount("af") != 1 || stream.keyframeCount("f") != 0 {
		t.Fatalf("PLI on the AV1 track: af %d IDRs, f %d", stream.keyframeCount("af"), stream.keyframeCount("f"))
	}
	if st := pub.Stats(); len(st.Layers) != 4 || st.Layers[3].RID != "af" || st.Layers[3].PLIs != 1 {
		t.Fatalf("stats %+v", st.Layers)
	}
}

// TestPublishSilentAppAudio: an announced audio track carries packets even when the
// captured app plays nothing. The SFU refuses to subscribe a viewer to a track that never
// carried one (empty_track_error), which left the viewers of a window shared with its
// silent app's sound on "reconnecting".
func TestPublishSilentAppAudio(t *testing.T) {
	preset, _ := media.FindPreset("1080p60")
	layers, _ := preset.Layers([]string{"q"})
	stream := newSilentAppStream(layers)
	defer func() { _ = stream.Stop() }()
	sig, err := NewLoopback()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sig.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pub, err := Publish(ctx, Config{
		Layers: layers, Audio: true, ICEServers: []webrtc.ICEServer{}, TrackPrefix: "test",
		KeyframeInterval: time.Second, Logger: slog.New(slog.DiscardHandler), SettingEngine: LoopbackSettings(),
	}, stream, sig)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for sig.Stats().Packets["audio"] < 10 {
		if time.Now().After(deadline) {
			t.Fatalf("no audio packets from a silent app: %v", sig.Stats().Packets)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if st := pub.Stats(); st.SilencePackets == 0 || st.SilencePackets != st.AudioPackets {
		t.Fatalf("stats %+v: every audio packet should be silence", st)
	}
	_ = pub.Close(context.Background())
}

// TestPublishSetLayers: a preset change (1440p60 → 1080p30) gives the encoders of the new
// capture the new preset's budget. Before SetLayers, the controller kept 1440p60's layers
// and sums, so its next decision could set the 1080p30 encoder f to 12000 kbit/s.
func TestPublishSetLayers(t *testing.T) {
	maxP, _ := media.FindPreset("1440p60")
	text, _ := media.FindPreset("1080p30")
	from, _ := maxP.Layers(media.AllRIDs)
	to, _ := text.Layers(media.AllRIDs)
	stream := newFakeStream(from, false)
	defer func() { _ = stream.Stop() }()
	sig, err := NewLoopback()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sig.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pub, err := Publish(ctx, Config{
		Layers: from, ICEServers: []webrtc.ICEServer{}, TrackPrefix: "test", EstimateMaxKbps: 30000,
		Logger: slog.New(slog.DiscardHandler), SettingEngine: LoopbackSettings(),
	}, stream, sig)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pub.Close(context.Background()) }()

	if err := pub.SetLayers(to[:2], 0); err == nil {
		t.Fatal("SetLayers took other RIDs")
	}
	if err := pub.SetLayers(to, 0); err != nil {
		t.Fatal(err)
	}
	stream.mu.Lock()
	got := map[string]int{"f": stream.bitrates["f"], "h": stream.bitrates["h"], "q": stream.bitrates["q"]}
	stream.mu.Unlock()
	if got["f"] != 6000 || got["h"] != 3500 || got["q"] != 1000 {
		t.Fatalf("bitrates after the change %v, want f=6000 h=3500 q=1000 (1080p30's)", got)
	}
	st := pub.Stats()
	if st.TargetKbps != 10500 || st.Layers[0].TargetKbps != 6000 {
		t.Fatalf("stats after the change: total %d, f %d; want 10500 and 6000", st.TargetKbps, st.Layers[0].TargetKbps)
	}

	// The room's cap fitted to the new layers: f absorbs the cut.
	if err := pub.SetLayers(to, 8000); err != nil {
		t.Fatal(err)
	}
	stream.mu.Lock()
	f := stream.bitrates["f"]
	stream.mu.Unlock()
	if f != 3500 {
		t.Fatalf("f %d under an 8000 kbit/s cap, want 3500", f)
	}
}

// offerRecorder keeps the offer the publisher sent.
type offerRecorder struct {
	*Loopback
	mu    sync.Mutex
	offer string
}

func (r *offerRecorder) Publish(ctx context.Context, offer SessionDescription, tracks []PublishedTrack) (PublishResult, error) {
	r.mu.Lock()
	r.offer = offer.SDP
	r.mu.Unlock()
	return r.Loopback.Publish(ctx, offer, tracks)
}

// TestPublishAnnouncesH264Level: the offer's H.264 entries carry the level the highest
// layer needs (1440p120: 5.2 = 0x34) instead of pion's 3.1, and the layers still flow.
func TestPublishAnnouncesH264Level(t *testing.T) {
	preset, _ := media.FindPreset("1440p120")
	layers, _ := preset.Layers(media.AllRIDs)
	stream := newFakeStream(layers, false)
	defer func() { _ = stream.Stop() }()
	lb, err := NewLoopback()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lb.Close() }()
	sig := &offerRecorder{Loopback: lb}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pub, err := Publish(ctx, Config{
		Layers: layers, ICEServers: []webrtc.ICEServer{}, TrackPrefix: "test",
		Logger: slog.New(slog.DiscardHandler), SettingEngine: LoopbackSettings(),
	}, stream, sig)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pub.Close(context.Background()) }()
	sig.mu.Lock()
	offer := sig.offer
	sig.mu.Unlock()
	if !strings.Contains(offer, "profile-level-id=42e034") || strings.Contains(offer, "profile-level-id=42e01f") {
		t.Fatalf("offer does not announce level 5.2 on every H.264 entry:\n%s", offer)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		pkts := lb.Stats().Packets
		if pkts["f"] > 5 && pkts["h"] > 5 && pkts["q"] > 5 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not every layer arrived: %v", pkts)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestWithH264Level(t *testing.T) {
	in := []webrtc.RTPCodecParameters{
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, PayloadType: 96},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"}, PayloadType: 125},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: "video/rtx", SDPFmtpLine: "apt=125"}, PayloadType: 107},
	}
	out := withH264Level(in, 51)
	if out[1].SDPFmtpLine != "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e033" || out[1].PayloadType != 125 {
		t.Fatalf("H.264 entry %+v", out[1])
	}
	if !reflect.DeepEqual(out[0], in[0]) || !reflect.DeepEqual(out[2], in[2]) {
		t.Fatalf("other codecs changed: %+v", out)
	}
	if in[1].SDPFmtpLine != "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" {
		t.Fatal("the input changed")
	}
}
