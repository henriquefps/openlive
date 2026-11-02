// SPDX-License-Identifier: AGPL-3.0-only

package rtc

import "context"

// SessionDescription is an SDP offer or answer, in the JSON shape the browser and the
// SFU use ({"type":"offer","sdp":"..."}).
type SessionDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// PublishedTrack is one track in a publish request: its transceiver mid and the name
// it gets on the SFU. Rids lists the simulcast encodings, highest first.
type PublishedTrack struct {
	Mid  string
	Name string
	Kind string // "video" or "audio"
	Rids []string
	// Codec is "av1" on the AV1 video track; empty on the H.264 one and on audio.
	Codec string
}

// PublishResult is the Worker's answer to a publish.
type PublishResult struct {
	SessionID string
	Answer    SessionDescription
}

// Signaler is how the publisher reaches the SFU. The real one goes through the Openlive
// Worker (POST /api/rtc/rooms/:roomId/publish and the session routes);
// tests use an in-process pion peer.
type Signaler interface {
	// Publish creates the publishing session and pushes the tracks in one offer.
	Publish(ctx context.Context, offer SessionDescription, tracks []PublishedTrack) (PublishResult, error)
	// Renegotiate sends a new offer on an existing session (for example when a track is added).
	Renegotiate(ctx context.Context, sessionID string, offer SessionDescription) (SessionDescription, error)
	// Unpublish closes the session's tracks.
	Unpublish(ctx context.Context, sessionID string) error
}
