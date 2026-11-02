// SPDX-License-Identifier: AGPL-3.0-only

// Package rtc publishes a media.Stream to the SFU with pion: one simulcast video track
// (one transceiver, one encoding per layer), a second one in AV1 when the stream has AV1
// layers, plus one Opus track, NACK, RTCP reports,
// TWCC feedback, a GCC bandwidth estimate that drives the encoders, and a watchdog for
// when GCC stops moving.
package rtc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	pionmedia "github.com/pion/webrtc/v4/pkg/media"

	"github.com/henriquefps/openlive/helper/internal/media"
)

// Config describes what to publish.
type Config struct {
	// Layers are the simulcast encodings, highest first. One layer publishes a plain
	// (non-simulcast) track.
	Layers []media.Layer
	Audio  bool
	// ICEServers default to Cloudflare's STUN server. The real helper passes the
	// short-lived TURN credentials from the Worker.
	ICEServers []webrtc.ICEServer
	// TrackPrefix names the tracks on the SFU: <prefix>-video and <prefix>-audio.
	TrackPrefix string
	// KeyframeInterval is the shortest time between two forced IDRs on one layer.
	KeyframeInterval time.Duration
	// Rate tunes the bitrate controller; MinKbps and MaxKbps default to the layers' sums.
	Rate RateConfig
	// EstimateMaxKbps caps what the bandwidth estimate probes for. It defaults to 1.5×
	// the layers' sum; a publication that can change preset (SetLayers) passes 1.5× the
	// largest one, since the estimator's cap cannot change once it runs.
	EstimateMaxKbps int
	// ConnectTimeout bounds waiting for ICE and DTLS after the answer.
	ConnectTimeout time.Duration
	Logger         *slog.Logger
	// SettingEngine is for tests (loopback-only ICE, for example).
	SettingEngine *webrtc.SettingEngine
}

// msid stream id shared by the audio and video tracks, so the viewer keeps them
// in sync.
const streamID = "openlive"

// Publisher is a live publication of one media.Stream.
type Publisher struct {
	cfg    Config
	log    *slog.Logger
	sig    Signaler
	stream media.Stream

	pc        *webrtc.PeerConnection
	sessionID string
	published []PublishedTrack
	video     map[string]*webrtc.TrackLocalStaticSample
	// clocks space each layer's frames on the RTP clock (media.FrameClock); only
	// pumpVideo touches them.
	clocks    map[string]*media.FrameClock
	audio     *webrtc.TrackLocalStaticSample
	keyframes map[string]*media.Keyframes

	estimator chan cc.BandwidthEstimator
	rate      *RateController
	loss      lossTracker

	mu sync.Mutex
	// encodings are the layers' current settings (SetLayers changes them; the RIDs stay).
	encodings []media.Layer
	layers    map[string]*LayerStats
	forced    map[string]time.Time // when the pending forced IDR of a layer was requested
	// requests counts keyframe requests per layer and RTCP sender SSRC.
	requests map[string]map[uint32]int
	est      int
	audioN   int
	// audioSilent counts the silence frames among audioN.
	audioSilent int
	closing     bool

	done     chan struct{}
	doneErr  error
	doneOnce sync.Once
	wg       sync.WaitGroup
}

// LayerStats is the running count for one layer.
type LayerStats struct {
	RID        string
	Frames     int
	Bytes      int
	Keyframes  int
	ForcedIDRs int
	// LastIDRDelay is how long the last forced IDR took to leave the encoder.
	LastIDRDelay time.Duration
	// PLIs and FIRs count the keyframe requests received, and Requesters the distinct
	// RTCP senders they came from (the SFU relays a subscriber's request with its own
	// sender SSRC, so one stuck receiver shows as one requester with a growing count).
	PLIs, FIRs, Requesters int
	TargetKbps             int
	// LastKeyframeBytes is the size of the latest keyframe sent (requested or not).
	LastKeyframeBytes int
}

// Stats is a snapshot of the publication.
type Stats struct {
	Layers       []LayerStats
	AudioPackets int
	// SilencePackets are the audio packets that were filled-in silence.
	SilencePackets int
	EstimateKbps   int
	TargetKbps     int
	CeilingKbps    int
	Loss           float64
}

// Publish negotiates through sig, waits until the PeerConnection is connected and
// starts sending stream's frames. The caller still owns stream and stops it after Close.
func Publish(ctx context.Context, cfg Config, stream media.Stream, sig Signaler) (*Publisher, error) {
	if len(cfg.Layers) == 0 {
		return nil, errors.New("rtc: no video layers")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.TrackPrefix == "" {
		cfg.TrackPrefix = fmt.Sprintf("helper-%d", time.Now().UnixMilli())
	}
	if cfg.KeyframeInterval == 0 {
		cfg.KeyframeInterval = 250 * time.Millisecond
	}
	if cfg.ConnectTimeout == 0 {
		cfg.ConnectTimeout = 15 * time.Second
	}
	if len(cfg.ICEServers) == 0 {
		cfg.ICEServers = []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}
	}
	target, minimum := SumTargets(cfg.Layers)
	if cfg.Rate.MaxKbps == 0 {
		cfg.Rate.MaxKbps = target
	}
	if cfg.Rate.MinKbps == 0 {
		cfg.Rate.MinKbps = minimum
	}

	p := &Publisher{
		cfg:       cfg,
		log:       cfg.Logger,
		sig:       sig,
		stream:    stream,
		video:     map[string]*webrtc.TrackLocalStaticSample{},
		clocks:    map[string]*media.FrameClock{},
		keyframes: map[string]*media.Keyframes{},
		layers:    map[string]*LayerStats{},
		forced:    map[string]time.Time{},
		requests:  map[string]map[uint32]int{},
		rate:      NewRateController(cfg.Rate, target),
		encodings: slices.Clone(cfg.Layers),
		done:      make(chan struct{}),
	}
	alloc := Allocate(p.rate.Target(), cfg.Layers)
	for i, l := range cfg.Layers {
		p.layers[l.RID] = &LayerStats{RID: l.RID, TargetKbps: alloc[i]}
		// The encoders start at the layers' targets; a lower cap (the room's
		// maxBitrateKbps) applies from the first frame.
		if alloc[i] != l.Kbps {
			if err := stream.SetBitrate(l.RID, alloc[i]); err != nil {
				p.log.Warn("set bitrate", "rid", l.RID, "err", err)
			}
		}
	}
	if err := p.negotiate(ctx); err != nil {
		if p.pc != nil {
			_ = p.pc.Close()
		}
		return nil, err
	}
	p.start()
	return p, nil
}

// newAPI builds the pion API: default codecs; the GCC controller first (closest to
// the socket after pion's own writer, so it sees every packet), the TWCC sequence
// numbers it needs, the defaults (NACK responder, RTCP reports, simulcast header
// extensions) and the rid/mid stamper.
func (p *Publisher) newAPI(stamper *ridStamper) (*webrtc.API, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	target, _ := SumTargets(p.cfg.Layers)
	controller, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		return gcc.NewSendSideBWE(
			// Start where the headroom gives the encoders their full target, so the
			// controller does not cut and climb back at start-up.
			gcc.SendSideBWEInitialBitrate(int(float64(target*1000)/p.rate.cfg.Headroom)),
			gcc.SendSideBWEMinBitrate(p.cfg.Rate.MinKbps*1000),
			gcc.SendSideBWEMaxBitrate(max(p.cfg.EstimateMaxKbps, target*3/2)*1000),
			// No pacer: frames leave as soon as they are encoded (latency first).
			gcc.SendSideBWEPacer(gcc.NewNoOpPacer()),
		)
	})
	if err != nil {
		return nil, err
	}
	p.estimator = make(chan cc.BandwidthEstimator, 1)
	controller.OnNewPeerConnection(func(_ string, e cc.BandwidthEstimator) {
		select {
		case p.estimator <- e:
		default:
		}
	})
	ir.Add(controller)
	if err := webrtc.ConfigureTWCCHeaderExtensionSender(m, ir); err != nil {
		return nil, err
	}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, err
	}
	ir.Add(stamper)
	opts := []func(*webrtc.API){webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir)}
	if p.cfg.SettingEngine != nil {
		opts = append(opts, webrtc.WithSettingEngine(*p.cfg.SettingEngine))
	}
	return webrtc.NewAPI(opts...), nil
}

func (p *Publisher) negotiate(ctx context.Context) error {
	stamper := newRIDStamper()
	api, err := p.newAPI(stamper)
	if err != nil {
		return fmt.Errorf("rtc: pion api: %w", err)
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers:   p.cfg.ICEServers,
		BundlePolicy: webrtc.BundlePolicyMaxBundle,
	})
	if err != nil {
		return fmt.Errorf("rtc: peer connection: %w", err)
	}
	p.pc = pc
	connected := make(chan struct{})
	var connectedOnce sync.Once
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		p.log.Debug("peer connection", "state", s.String())
		switch s {
		case webrtc.PeerConnectionStateConnected:
			connectedOnce.Do(func() { close(connected) })
		case webrtc.PeerConnectionStateFailed:
			p.finish(errors.New("rtc: peer connection failed"))
		case webrtc.PeerConnectionStateClosed:
			p.finish(nil)
		}
	})

	tracks, err := p.addVideo(pc, stamper)
	if err != nil {
		return err
	}
	var audioTr *webrtc.RTPTransceiver
	if p.cfg.Audio {
		t, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
		}, "audio", streamID)
		if err != nil {
			return fmt.Errorf("rtc: audio track: %w", err)
		}
		p.audio = t
		audioTr, err = pc.AddTransceiverFromTrack(t, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		if err != nil {
			return fmt.Errorf("rtc: audio transceiver: %w", err)
		}
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("rtc: offer: %w", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("rtc: set local description: %w", err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		return ctx.Err()
	}
	for _, t := range tracks {
		for _, e := range t.tr.Sender().GetParameters().Encodings {
			stamper.setMid(uint32(e.SSRC), t.tr.Mid())
		}
		p.published = append(p.published, t.published(t.tr.Mid()))
	}
	if audioTr != nil {
		p.published = append(p.published, PublishedTrack{Mid: audioTr.Mid(), Name: p.cfg.TrackPrefix + "-audio", Kind: "audio"})
	}

	local := pc.LocalDescription()
	res, err := p.sig.Publish(ctx, SessionDescription{Type: local.Type.String(), SDP: local.SDP}, p.published)
	if err != nil {
		return fmt.Errorf("rtc: publish: %w", err)
	}
	p.sessionID = res.SessionID
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: res.Answer.SDP}); err != nil {
		return fmt.Errorf("rtc: set remote description: %w", err)
	}

	for _, t := range tracks {
		sender := t.tr.Sender()
		var exts []string
		for _, e := range sender.GetParameters().HeaderExtensions {
			exts = append(exts, e.URI)
		}
		p.log.Debug("video track negotiated", "codec", t.codec, "mid", t.tr.Mid(), "extensions", exts)
		for _, l := range t.layers {
			rid, wire := l.RID, l.WireRID()
			p.keyframes[rid] = media.NewKeyframes(p.cfg.KeyframeInterval, func() { p.forceKeyframe(rid) })
			read := func() ([]rtcp.Packet, error) {
				pkts, _, err := sender.ReadRTCP()
				return pkts, err
			}
			if len(t.layers) > 1 {
				read = func() ([]rtcp.Packet, error) {
					pkts, _, err := sender.ReadSimulcastRTCP(wire)
					return pkts, err
				}
			}
			p.wg.Add(1)
			go p.readRTCP(rid, read)
		}
	}
	if audioTr != nil {
		p.wg.Add(1)
		go p.readRTCP("", func() ([]rtcp.Packet, error) {
			pkts, _, err := audioTr.Sender().ReadRTCP()
			return pkts, err
		})
	}

	timer := time.NewTimer(p.cfg.ConnectTimeout)
	defer timer.Stop()
	select {
	case <-connected:
		return nil
	case <-p.done:
		return p.doneErr
	case <-timer.C:
		return fmt.Errorf("rtc: not connected after %v", p.cfg.ConnectTimeout)
	case <-ctx.Done():
		return ctx.Err()
	}
}

// videoTrack is one published video track: the layers of one codec on one transceiver.
type videoTrack struct {
	codec  media.Codec
	layers []media.Layer
	tr     *webrtc.RTPTransceiver
	name   string
}

func (t videoTrack) published(mid string) PublishedTrack {
	pt := PublishedTrack{Mid: mid, Name: t.name, Kind: "video"}
	if t.codec != media.CodecH264 {
		pt.Codec = string(t.codec)
	}
	if len(t.layers) > 1 {
		for _, l := range t.layers {
			pt.Rids = append(pt.Rids, l.WireRID())
		}
	}
	return pt
}

// videoCapability is the codec a track binds to. H.264: pion's default entry
// (constrained baseline, level 3.1); the offer then announces the level the layers need
// (withH264Level). AV1: pion's entry (profile 0, main), payloaded from the OBU stream.
func videoCapability(c media.Codec) webrtc.RTPCodecCapability {
	if c == media.CodecAV1 {
		return webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeAV1, ClockRate: 90000}
	}
	return webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeH264,
		ClockRate:   90000,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
	}
}

// addVideo adds one sendonly transceiver per codec, H.264 first: one encoding per layer
// (simulcast) or a plain track for a single layer. The AV1 track,
// <prefix>-video-av1, is the top layer alone: the SFU does not negotiate
// the AV1 Dependency Descriptor, and without it it never switched layers inside an AV1
// simulcast track. A simulcast AV1 track would use the wire RIDs f, h and q
// (Layer.WireRID) like the H.264 one.
func (p *Publisher) addVideo(pc *webrtc.PeerConnection, stamper *ridStamper) ([]videoTrack, error) {
	var tracks []videoTrack
	for _, c := range []media.Codec{media.CodecH264, media.CodecAV1} {
		layers := media.LayersOf(p.cfg.Layers, c)
		if len(layers) == 0 {
			continue
		}
		t := videoTrack{codec: c, layers: layers, name: p.cfg.TrackPrefix + "-video"}
		if c != media.CodecH264 {
			t.name += "-" + string(c)
		}
		simulcast := len(layers) > 1
		var sender *webrtc.RTPSender
		for i, l := range layers {
			var opts []func(*webrtc.TrackLocalStaticRTP)
			if simulcast {
				opts = append(opts, webrtc.WithRTPStreamID(l.WireRID()))
			}
			// Every video track shares the msid stream with the audio: a viewer
			// pulls one of them.
			id := "video"
			if c != media.CodecH264 {
				id += "-" + string(c)
			}
			local, err := webrtc.NewTrackLocalStaticSample(videoCapability(c), id, streamID, opts...)
			if err != nil {
				return nil, fmt.Errorf("rtc: track %s: %w", l.RID, err)
			}
			p.video[l.RID] = local
			if i == 0 {
				if t.tr, err = pc.AddTransceiverFromTrack(local, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
					return nil, fmt.Errorf("rtc: %s transceiver: %w", c, err)
				}
				sender = t.tr.Sender()
			} else if err := sender.AddEncoding(local); err != nil {
				return nil, fmt.Errorf("rtc: add encoding %s: %w", l.RID, err)
			}
		}
		if simulcast {
			for _, e := range sender.GetParameters().Encodings {
				stamper.set(uint32(e.SSRC), e.RID)
			}
		}
		codecs := sender.GetParameters().Codecs
		if c == media.CodecAV1 {
			// Only AV1 (and its RTX): the SFU answers with it or refuses the track.
			codecs = onlyCodec(codecs, webrtc.MimeTypeAV1)
		} else {
			level := media.SDPLevel(layers)
			codecs = withH264Level(codecs, level)
			p.log.Debug("h264 level", "sdp", media.LevelName(level), "layers", layerLevels(layers))
		}
		if err := t.tr.SetCodecPreferences(codecs); err != nil {
			return nil, fmt.Errorf("rtc: %s codec preferences: %w", c, err)
		}
		tracks = append(tracks, t)
	}
	if len(tracks) == 0 || tracks[0].codec != media.CodecH264 {
		return nil, errors.New("rtc: no H.264 layers (the AV1 track only mirrors them)")
	}
	return tracks, nil
}

// onlyCodec keeps the entries of one codec and the RTX entries pointing at them.
func onlyCodec(codecs []webrtc.RTPCodecParameters, mime string) []webrtc.RTPCodecParameters {
	var out []webrtc.RTPCodecParameters
	pts := map[webrtc.PayloadType]bool{}
	for _, c := range codecs {
		if strings.EqualFold(c.MimeType, mime) {
			out = append(out, c)
			pts[c.PayloadType] = true
		}
	}
	for _, c := range codecs {
		if strings.EqualFold(c.MimeType, webrtc.MimeTypeRTX) {
			var apt int
			if _, err := fmt.Sscanf(c.SDPFmtpLine, "apt=%d", &apt); err == nil && pts[webrtc.PayloadType(apt)] {
				out = append(out, c)
			}
		}
	}
	return out
}

func (p *Publisher) start() {
	p.wg.Add(2)
	go p.pumpVideo()
	go p.pumpAudio()
	go p.controlRate()
}

// SessionID is the SFU session the tracks were published on.
func (p *Publisher) SessionID() string { return p.sessionID }

// Tracks are the published tracks, video first.
func (p *Publisher) Tracks() []PublishedTrack { return p.published }

// Done is closed when the publication ends; Err then says why (nil after Close).
func (p *Publisher) Done() <-chan struct{} { return p.done }

// Err is the reason the publication ended.
func (p *Publisher) Err() error {
	select {
	case <-p.done:
		return p.doneErr
	default:
		return nil
	}
}

func (p *Publisher) finish(err error) {
	p.doneOnce.Do(func() {
		p.doneErr = err
		close(p.done)
	})
}

// Close unpublishes the tracks and closes the PeerConnection.
func (p *Publisher) Close(ctx context.Context) error {
	p.mu.Lock()
	p.closing = true
	p.mu.Unlock()
	var err error
	if p.sessionID != "" {
		err = p.sig.Unpublish(ctx, p.sessionID)
	}
	p.finish(nil)
	if cerr := p.pc.Close(); cerr != nil && err == nil {
		err = cerr
	}
	return err
}

func (p *Publisher) pumpVideo() {
	defer p.wg.Done()
	for {
		select {
		case f, ok := <-p.stream.Video():
			if !ok {
				return
			}
			p.writeVideo(f)
		case <-p.done:
			return
		}
	}
}

func (p *Publisher) writeVideo(f media.EncodedFrame) {
	t, ok := p.video[f.RID]
	if !ok {
		return
	}
	p.writeVideoSample(t, f, time.Now())
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.layers[f.RID]
	s.Frames++
	s.Bytes += len(f.Data)
	if f.Keyframe {
		s.Keyframes++
		s.LastKeyframeBytes = len(f.Data)
		if at, ok := p.forced[f.RID]; ok {
			delete(p.forced, f.RID)
			s.LastIDRDelay = time.Since(at)
			p.log.Info("forced IDR out of the encoder", "rid", f.RID, "after", s.LastIDRDelay.Round(100*time.Microsecond), "bytes", len(f.Data))
		}
	}
}

// writeVideoSample sends f with its RTP timestamp following the real time since the
// layer's previous frame (media.FrameClock), not the frame's nominal duration: pion
// advances the timestamp after a sample by its Duration, so the gap goes first as an empty
// sample (it only moves the clock) and the frame itself has no duration.
func (p *Publisher) writeVideoSample(t *webrtc.TrackLocalStaticSample, f media.EncodedFrame, now time.Time) {
	c := p.clocks[f.RID]
	if c == nil {
		c = &media.FrameClock{}
		p.clocks[f.RID] = c
	}
	if gap := c.Gap(f.PTS, now); gap > 0 {
		if err := t.WriteSample(pionmedia.Sample{Duration: gap}); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			p.log.Warn("advance video clock", "rid", f.RID, "err", err)
		}
	}
	if err := t.WriteSample(pionmedia.Sample{Data: f.Data}); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		p.log.Warn("write video sample", "rid", f.RID, "err", err)
	}
}

// opusSilence is one 20 ms Opus frame of digital silence (TOC 0xf8: CELT, fullband, 20 ms).
var opusSilence = []byte{0xf8, 0xff, 0xfe}

// silenceAfter is how long the audio may go without a frame before silence fills in.
const silenceAfter = 60 * time.Millisecond

// pumpAudio sends the encoded audio, and Opus silence while there is none: a captured app
// that plays nothing gives no PCM and so no frames, and the SFU refuses to subscribe a
// viewer to a track that never carried a packet (empty_track_error: the viewer's player
// stayed on "reconnecting" for a window shared with a silent app's sound).
func (p *Publisher) pumpAudio() {
	defer p.wg.Done()
	if p.audio == nil {
		return
	}
	ch := p.stream.Audio()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	write := func(data []byte, d time.Duration) {
		if err := p.audio.WriteSample(pionmedia.Sample{Data: data, Duration: d}); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			p.log.Warn("write audio sample", "err", err)
		}
		p.mu.Lock()
		p.audioN++
		p.mu.Unlock()
	}
	// Silence first, so the track carries packets before the capture has any.
	last := time.Now().Add(-silenceAfter)
	for {
		select {
		case f, ok := <-ch:
			if !ok {
				ch = nil
				continue
			}
			write(f.Data, f.Duration)
			last = time.Now()
		case now := <-tick.C:
			if now.Sub(last) >= silenceAfter {
				write(opusSilence, 20*time.Millisecond)
				p.mu.Lock()
				p.audioSilent++
				p.mu.Unlock()
			}
		case <-p.done:
			return
		}
	}
}

// readRTCP drains one sender's RTCP (pion's interceptors need it read) and handles
// keyframe requests and receiver reports. rid is empty for audio.
func (p *Publisher) readRTCP(rid string, read func() ([]rtcp.Packet, error)) {
	defer p.wg.Done()
	for {
		pkts, err := read()
		if err != nil {
			return
		}
		for _, pkt := range pkts {
			switch pkt := pkt.(type) {
			case *rtcp.PictureLossIndication:
				if rid != "" {
					p.keyframeRequest(rid, "pli", pkt.SenderSSRC, pkt.MediaSSRC)
				}
			case *rtcp.FullIntraRequest:
				if rid != "" {
					p.keyframeRequest(rid, "fir", pkt.SenderSSRC, pkt.MediaSSRC)
				}
			case *rtcp.ReceiverReport:
				p.loss.record(pkt.Reports, time.Now())
			case *rtcp.SenderReport:
				p.loss.record(pkt.Reports, time.Now())
			}
		}
	}
}

// keyframeRequest counts a PLI or FIR on a layer by its sender and asks for an IDR (the
// Keyframes limiter coalesces bursts). A sender's first request is logged at info, the
// rest at debug with its running count, so a PLI loop can be traced to one requester.
func (p *Publisher) keyframeRequest(rid, kind string, sender, mediaSSRC uint32) {
	p.mu.Lock()
	s := p.layers[rid]
	if kind == "fir" {
		s.FIRs++
	} else {
		s.PLIs++
	}
	by := p.requests[rid]
	if by == nil {
		by = map[uint32]int{}
		p.requests[rid] = by
	}
	by[sender]++
	n := by[sender]
	s.Requesters = len(by)
	p.mu.Unlock()
	level := slog.LevelDebug
	if n == 1 {
		level = slog.LevelInfo
	}
	p.log.Log(context.Background(), level, "keyframe request", "rid", rid, "type", kind, "sender", sender, "mediaSsrc", mediaSSRC, "fromSender", n)
	p.keyframes[rid].Request()
}

func (p *Publisher) forceKeyframe(rid string) {
	p.mu.Lock()
	if _, waiting := p.forced[rid]; !waiting {
		p.forced[rid] = time.Now()
	}
	p.layers[rid].ForcedIDRs++
	p.mu.Unlock()
	if err := p.stream.RequestKeyframe(rid); err != nil {
		p.log.Warn("force keyframe", "rid", rid, "err", err)
	}
}

// controlRate applies the GCC estimate and the watchdog every 100 ms.
func (p *Publisher) controlRate() {
	var est cc.BandwidthEstimator
	select {
	case est = <-p.estimator:
	case <-p.done:
		return
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case now := <-tick.C:
			bps := est.GetTargetBitrate()
			loss := p.loss.current(now)
			p.mu.Lock()
			d := p.rate.Step(now, bps, loss)
			p.est = bps
			p.mu.Unlock()
			if d.Changed {
				p.applyBitrate(d, bps, loss)
			}
		case <-p.done:
			return
		}
	}
}

func (p *Publisher) applyBitrate(d Decision, estimateBps int, loss float64) {
	p.mu.Lock()
	layers := p.encodings
	alloc := Allocate(d.Kbps, layers)
	var changed []int
	for i, l := range layers {
		s := p.layers[l.RID]
		if s.TargetKbps != alloc[i] {
			changed = append(changed, i)
		}
		s.TargetKbps = alloc[i]
	}
	p.mu.Unlock()
	p.log.Info("bitrate", "reason", d.Reason, "estimateKbps", estimateBps/1000, "lossPct", int(loss*100), "totalKbps", d.Kbps, "layersKbps", alloc)
	for _, i := range changed {
		if err := p.stream.SetBitrate(layers[i].RID, alloc[i]); err != nil {
			p.log.Warn("set bitrate", "rid", layers[i].RID, "err", err)
		}
	}
}

// SetLayers takes the layers of a new capture swapped in under this publication (a
// preset change): the same RIDs with other sizes, frame rates and bitrates. The rate
// controller gets the new layers' budget (maxKbps caps it, 0 = their sum: the room's
// maxBitrateKbps fitted to the new layers) and every layer's encoder its share, which
// a new capture needs because its encoders start at their own targets.
func (p *Publisher) SetLayers(layers []media.Layer, maxKbps int) error {
	p.mu.Lock()
	if len(layers) != len(p.encodings) {
		p.mu.Unlock()
		return fmt.Errorf("rtc: %d layers, the publication has %d", len(layers), len(p.encodings))
	}
	for i, l := range layers {
		if l.RID != p.encodings[i].RID {
			p.mu.Unlock()
			return fmt.Errorf("rtc: layer %d is %q, the publication's is %q", i, l.RID, p.encodings[i].RID)
		}
	}
	target, minimum := SumTargets(layers)
	if maxKbps <= 0 {
		maxKbps = target
	}
	p.rate.Reset(minimum, maxKbps, target, p.est)
	total := p.rate.Target()
	p.encodings = slices.Clone(layers)
	alloc := Allocate(total, layers)
	for i, l := range layers {
		p.layers[l.RID].TargetKbps = alloc[i]
	}
	p.mu.Unlock()
	p.log.Info("bitrate", "reason", "layers", "totalKbps", total, "maxKbps", maxKbps, "layersKbps", alloc)
	// Every layer, changed or not: the new encoders may have been set from the old
	// budget between the swap and this call.
	for i, l := range layers {
		if err := p.stream.SetBitrate(l.RID, alloc[i]); err != nil {
			p.log.Warn("set bitrate", "rid", l.RID, "err", err)
		}
	}
	return nil
}

// Stats returns a snapshot.
func (p *Publisher) Stats() Stats {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := Stats{AudioPackets: p.audioN, SilencePackets: p.audioSilent, EstimateKbps: p.est / 1000, TargetKbps: p.rate.Target(), CeilingKbps: p.rate.Ceiling(), Loss: p.loss.current(time.Now())}
	for _, l := range p.encodings {
		out.Layers = append(out.Layers, *p.layers[l.RID])
	}
	return out
}

// lossTracker keeps the latest fraction lost per SSRC from receiver reports and answers
// with the worst one still fresh.
type lossTracker struct {
	mu     sync.Mutex
	latest map[uint32]lossSample
}

type lossSample struct {
	fraction float64
	at       time.Time
}

const lossFresh = 1500 * time.Millisecond

func (t *lossTracker) record(reports []rtcp.ReceptionReport, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.latest == nil {
		t.latest = map[uint32]lossSample{}
	}
	for _, r := range reports {
		t.latest[r.SSRC] = lossSample{fraction: float64(r.FractionLost) / 256, at: now}
	}
}

func (t *lossTracker) current(now time.Time) float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	worst := 0.0
	for _, s := range t.latest {
		if now.Sub(s.at) <= lossFresh {
			worst = max(worst, s.fraction)
		}
	}
	return worst
}

// withH264Level returns codecs with the level of every H.264 profile-level-id set to level,
// keeping the payload types (and so the RTX entries that point at them). The level is
// what the layers' SPS carry at most (media.SDPLevel): 1080p60 needs 4.2 and 1440p120 5.2,
// while pion's default entries all say 3.1. pion matches codecs on the profile and the
// packetization mode only, so the track still binds to its entry.
func withH264Level(codecs []webrtc.RTPCodecParameters, level int) []webrtc.RTPCodecParameters {
	out := slices.Clone(codecs)
	for i, c := range out {
		if !strings.EqualFold(c.MimeType, webrtc.MimeTypeH264) {
			continue
		}
		params := strings.Split(c.SDPFmtpLine, ";")
		for j, kv := range params {
			if k, v, ok := strings.Cut(kv, "="); ok && strings.TrimSpace(k) == "profile-level-id" && len(v) == 6 {
				params[j] = fmt.Sprintf("%s=%s%02x", k, v[:4], level)
			}
		}
		out[i].SDPFmtpLine = strings.Join(params, ";")
	}
	return out
}

// layerLevels lists each layer's own level, for the log.
func layerLevels(layers []media.Layer) []string {
	var out []string
	for _, l := range layers {
		out = append(out, l.RID+"="+media.LevelName(l.H264Level()))
	}
	return out
}
