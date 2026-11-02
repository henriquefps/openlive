// SPDX-License-Identifier: AGPL-3.0-only

package rtc

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/henriquefps/openlive/helper/internal/media"
)

// Loopback is a Signaler that answers with an in-process pion receiver instead of the
// Worker and the SFU. `test-stream --loopback` and the tests use it to run the whole
// send path (encoders, simulcast, rid/mid stamping, RTCP) on one machine. Like the SFU,
// the receiver only tells the layers apart through the rid/mid header extensions.
type Loopback struct {
	pc *webrtc.PeerConnection

	mu          sync.Mutex
	ssrc        map[string]webrtc.SSRC // layer (the helper's RID: "af" on the AV1 track; "audio") -> SSRC
	packets     map[string]int
	bytes       map[string]int
	unpublished bool
}

// LoopbackSettings restricts ICE to loopback UDP, for both ends of a loopback call.
func LoopbackSettings() *webrtc.SettingEngine {
	se := &webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	return se
}

// NewLoopback creates the receiving peer.
func NewLoopback() (*Loopback, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(*LoopbackSettings()))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	l := &Loopback{pc: pc, ssrc: map[string]webrtc.SSRC{}, packets: map[string]int{}, bytes: map[string]int{}}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		key := track.RID()
		switch {
		case track.Kind() == webrtc.RTPCodecTypeAudio:
			key = "audio"
		case strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeAV1):
			// The helper's names: the AV1 track is the top layer alone, "af".
			if key == "" {
				key = media.AllRIDs[0]
			}
			key = media.AV1RID(key)
		}
		l.mu.Lock()
		l.ssrc[key] = track.SSRC()
		l.mu.Unlock()
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			l.mu.Lock()
			l.packets[key]++
			l.bytes[key] += len(pkt.Payload)
			l.mu.Unlock()
		}
	})
	return l, nil
}

const loopbackSession = "loopback-session"

func (l *Loopback) Publish(ctx context.Context, offer SessionDescription, _ []PublishedTrack) (PublishResult, error) {
	if err := l.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		return PublishResult{}, err
	}
	answer, err := l.pc.CreateAnswer(nil)
	if err != nil {
		return PublishResult{}, err
	}
	gathered := webrtc.GatheringCompletePromise(l.pc)
	if err := l.pc.SetLocalDescription(answer); err != nil {
		return PublishResult{}, err
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		return PublishResult{}, ctx.Err()
	}
	return PublishResult{SessionID: loopbackSession, Answer: SessionDescription{Type: "answer", SDP: l.pc.LocalDescription().SDP}}, nil
}

func (l *Loopback) Renegotiate(context.Context, string, SessionDescription) (SessionDescription, error) {
	return SessionDescription{}, errors.New("loopback: renegotiation is not supported")
}

func (l *Loopback) Unpublish(_ context.Context, sessionID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.unpublished = sessionID == loopbackSession
	return nil
}

// Unpublished reports whether the publisher closed its session.
func (l *Loopback) Unpublished() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.unpublished
}

// LoopbackStats is what the receiver got per rid ("audio" for audio).
type LoopbackStats struct {
	SSRC    map[string]webrtc.SSRC
	Packets map[string]int
	Bytes   map[string]int
}

// Stats returns copies of the counters.
func (l *Loopback) Stats() LoopbackStats {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := LoopbackStats{SSRC: map[string]webrtc.SSRC{}, Packets: map[string]int{}, Bytes: map[string]int{}}
	for k, v := range l.ssrc {
		s.SSRC[k] = v
	}
	for k, v := range l.packets {
		s.Packets[k] = v
	}
	for k, v := range l.bytes {
		s.Bytes[k] = v
	}
	return s
}

// SendPLI asks the publisher for a keyframe on one layer, as the SFU relays a viewer's
// PLI. It fails until that layer has arrived.
func (l *Loopback) SendPLI(rid string) error {
	l.mu.Lock()
	ssrc, ok := l.ssrc[rid]
	l.mu.Unlock()
	if !ok {
		return errors.New("loopback: layer " + rid + " has not arrived")
	}
	return l.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(ssrc)}})
}

// Close closes the receiving peer.
func (l *Loopback) Close() error { return l.pc.Close() }
