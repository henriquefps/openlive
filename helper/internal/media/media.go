// SPDX-License-Identifier: AGPL-3.0-only

// Package media holds the MediaBackend and Stream interfaces and the
// backends behind them. The only backend so far is the synthetic test source
// ("helper de teste"): a GStreamer test pattern with a frame counter and a
// wall clock, encoded as three simulcast layers, plus an Opus test tone.
package media

import (
	"context"
	"errors"
	"time"
)

// Profile says how to encode a source: the simulcast layers (highest first), the
// encoder and whether audio is captured.
type Profile struct {
	// Layers are the H.264 layers, highest first, then their AV1 mirror when the stream
	// publishes the AV1 track too (WithAV1).
	Layers  []Layer
	Encoder Encoder
	Audio   bool
	// GOP is the fallback keyframe interval. Keyframes normally come on demand (PLI/FIR),
	// so it is long.
	GOP time.Duration
}

// EncodedFrame is one encoded access unit: H.264 Annex B or one AV1 temporal unit (OBUs with
// size fields) for video, one Opus packet for audio.
type EncodedFrame struct {
	// RID is the simulcast layer of a video frame (Layer.RID: "af" for the AV1 track's f);
	// empty for audio.
	RID      string
	Data     []byte
	Keyframe bool
	PTS      time.Duration
	Duration time.Duration
}

// MediaBackend lists and starts sources.
type MediaBackend interface {
	ListSources(ctx context.Context) ([]Source, error)
	Start(ctx context.Context, src Source, p Profile) (Stream, error)
}

// Stream is a running capture and encode.
//
// It differs from the §9.3 sketch in one way: SetBitrate and RequestKeyframe take the
// simulcast layer, because each layer has its own encoder (one track, three encodings)
// and a PLI/FIR arrives for one layer's SSRC.
type Stream interface {
	// Video carries the frames of every layer; EncodedFrame.RID tells them apart.
	Video() <-chan EncodedFrame
	// Audio is nil when the profile has no audio.
	Audio() <-chan EncodedFrame
	// SetBitrate changes one layer's encoder bitrate live, keeping the VBV size fixed.
	SetBitrate(rid string, kbps int) error
	// RequestKeyframe asks one layer's encoder for an IDR now. Callers rate-limit
	// through Keyframes; the backend forces one per call.
	RequestKeyframe(rid string) error
	// Err reports a fatal pipeline error once, then is closed by Stop.
	Err() <-chan error
	Stop() error
}

// ErrUnavailable is returned by backends that were not built into this binary
// (for example GStreamer in a build with the nogst tag).
var ErrUnavailable = errors.New("media backend not available in this build")
