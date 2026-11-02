// SPDX-License-Identifier: AGPL-3.0-only

package rtc

import (
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

// Header extension URIs the stamper writes.
const (
	uriRID = "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"
	uriMID = "urn:ietf:params:rtp-hdrext:sdes:mid"
)

// ridStamper writes the sdes:mid and sdes:rtp-stream-id header extensions on every
// outgoing packet of a simulcast encoding. pion v4.2 negotiates these extensions but does
// not set them on packets, and without them the SFU cannot map an SSRC to a RID (the SDP
// carries no SSRC per RID), so it never sees the track (Phase 0 P6).
//
// It is its own interceptor factory, so one instance can be added to a Registry and
// configured (set, setMid) after the PeerConnection exists. Each SSRC has its own mid: an
// AV1 track is a second simulcast transceiver with the same RIDs as the H.264 one.
type ridStamper struct {
	interceptor.NoOp
	rids sync.Map // ssrc (uint32) -> rid (string)
	mids sync.Map // ssrc (uint32) -> mid (string)
}

func newRIDStamper() *ridStamper { return &ridStamper{} }

// set maps an encoding's SSRC to its RID. Call it before the remote description is set,
// which is when pion binds the local streams.
func (s *ridStamper) set(ssrc uint32, rid string) { s.rids.Store(ssrc, rid) }

// setMid is the mid of the encoding's transceiver, known after SetLocalDescription.
func (s *ridStamper) setMid(ssrc uint32, mid string) { s.mids.Store(ssrc, mid) }

func (s *ridStamper) NewInterceptor(string) (interceptor.Interceptor, error) { return s, nil }

func (s *ridStamper) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	v, ok := s.rids.Load(info.SSRC)
	if !ok {
		return writer
	}
	rid := []byte(v.(string))
	var ridID, midID uint8
	for _, e := range info.RTPHeaderExtensions {
		switch e.URI {
		case uriRID:
			ridID = uint8(e.ID)
		case uriMID:
			midID = uint8(e.ID)
		}
	}
	if ridID == 0 && midID == 0 {
		return writer
	}
	ssrc := info.SSRC
	return interceptor.RTPWriterFunc(func(h *rtp.Header, payload []byte, a interceptor.Attributes) (int, error) {
		if ridID != 0 {
			_ = h.SetExtension(ridID, rid)
		}
		if mid, _ := s.mids.Load(ssrc); midID != 0 && mid != nil && mid.(string) != "" {
			_ = h.SetExtension(midID, []byte(mid.(string)))
		}
		return writer.Write(h, payload, a)
	})
}
