// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/henriquefps/openlive/helper/internal/rtc"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Signaler implements rtc.Signaler through the Worker: the SFU's API secret never
// leaves it, so every SFU call goes through /api/rtc/rooms/:roomId/*
// (PROTOCOL.md §11.2), where the room's RoomDO serializes the calls on the session.
type Signaler struct {
	Client *Client
	RoomID string
	// Preset and MaxBitrateKbps go with the publish: the Worker refuses a preset or a
	// bitrate the room does not allow (preset_not_allowed, bitrate_not_allowed).
	Preset         protocol.Preset
	MaxBitrateKbps int

	// AnnounceWithin is set by Publish: stream.announce must follow within it.
	AnnounceWithin time.Duration
	// QualityCap is set by Publish while economy mode is on: fit
	// the stream under it before announcing.
	QualityCap *protocol.QualityCap
}

var _ rtc.Signaler = (*Signaler)(nil)

func (s *Signaler) path(format string) string { return fmt.Sprintf(format, url.PathEscape(s.RoomID)) }

func toProtocol(d rtc.SessionDescription) protocol.SessionDescription {
	return protocol.SessionDescription{Type: protocol.SDPType(d.Type), SDP: d.SDP}
}

func fromProtocol(d protocol.SessionDescription) rtc.SessionDescription {
	return rtc.SessionDescription{Type: string(d.Type), SDP: d.SDP}
}

// TrackCodec is a published track's codec for the protocol: set on the AV1 track only, so
// a stream without one reads as before 1.14.
func TrackCodec(t rtc.PublishedTrack) *protocol.VideoCodec {
	if t.Codec == "" {
		return nil
	}
	c := protocol.VideoCodec(t.Codec)
	return &c
}

func (s *Signaler) Publish(ctx context.Context, offer rtc.SessionDescription, tracks []rtc.PublishedTrack) (rtc.PublishResult, error) {
	req := protocol.PublishRequest{SessionDescription: toProtocol(offer), Preset: s.Preset, MaxBitrateKbps: s.MaxBitrateKbps}
	for _, t := range tracks {
		req.Tracks = append(req.Tracks, protocol.PublishTrack{Mid: t.Mid, TrackName: t.Name, Kind: protocol.TrackKind(t.Kind), Rids: t.Rids, Codec: TrackCodec(t)})
	}
	var res protocol.PublishResponse
	if err := s.Client.Do(ctx, "POST", s.path(pathPublishFmt), req, &res); err != nil {
		return rtc.PublishResult{}, err
	}
	if res.SFUSessionID == "" || res.SessionDescription.SDP == "" {
		return rtc.PublishResult{}, errors.New("publish: the answer has no session or SDP")
	}
	s.AnnounceWithin = time.Duration(res.AnnounceWithinMs) * time.Millisecond
	s.QualityCap = res.QualityCap
	return rtc.PublishResult{SessionID: res.SFUSessionID, Answer: fromProtocol(res.SessionDescription)}, nil
}

func (s *Signaler) Renegotiate(ctx context.Context, sessionID string, offer rtc.SessionDescription) (rtc.SessionDescription, error) {
	var res protocol.RenegotiateResponse
	err := s.Client.Do(ctx, "PUT", s.path(pathPublishRenegotiateFmt),
		protocol.PublishRenegotiateRequest{SFUSessionID: sessionID, SessionDescription: toProtocol(offer)}, &res)
	if err != nil {
		return rtc.SessionDescription{}, err
	}
	if res.SessionDescription == nil {
		return rtc.SessionDescription{}, errors.New("renegotiate: the answer has no SDP")
	}
	return fromProtocol(*res.SessionDescription), nil
}

// Unpublish closes the publication's tracks; the room then ends the stream with
// ended_by_streamer. It is idempotent.
func (s *Signaler) Unpublish(ctx context.Context, sessionID string) error {
	return s.Client.Do(ctx, "POST", s.path(pathUnpublishFmt), protocol.UnpublishRequest{SFUSessionID: sessionID}, nil)
}

// ICEServers fetches short-lived STUN and TURN servers for a room
// (POST /api/rtc/rooms/:roomId/ice).
func (c *Client) ICEServers(ctx context.Context, roomID string) ([]protocol.ICEServer, error) {
	var res protocol.ICEServersResponse
	if err := c.Do(ctx, "POST", fmt.Sprintf(pathICEFmt, url.PathEscape(roomID)), nil, &res); err != nil {
		return nil, err
	}
	return res.ICEServers, nil
}

// RoomSettings returns the room's effective limits (GET /api/rooms/:roomId), which the
// helper needs before it publishes: the allowed presets and maxBitrateKbps.
func (c *Client) RoomSettings(ctx context.Context, roomID string) (protocol.RoomSettings, error) {
	var res struct {
		Room struct {
			EffectiveSettings protocol.RoomSettings `json:"effectiveSettings"`
		} `json:"room"`
	}
	if err := c.Do(ctx, "GET", fmt.Sprintf(pathRoomFmt, url.PathEscape(roomID)), nil, &res); err != nil {
		return protocol.RoomSettings{}, err
	}
	return res.Room.EffectiveSettings, nil
}
