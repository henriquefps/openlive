// SPDX-License-Identifier: AGPL-3.0-only

// Package sidecar speaks the wire protocol of the macOS capture sidecar
// (helper/macos-capture): length-prefixed messages over a Unix stream socket. The Swift side
// (Sources/CaptureProtocol/Wire.swift) mirrors this file, and both test suites check the same
// bytes.
//
// Every message is a 4-byte big-endian length (of what follows), a 1-byte type and the
// payload. Video and audio carry a fixed binary header before the data; the rest is JSON.
package sidecar

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Type is a message type.
type Type byte

const (
	// Sidecar → helper.
	TypeHello     Type = 0x01
	TypeStarted   Type = 0x02
	TypeVideo     Type = 0x03
	TypeAudio     Type = 0x04
	TypeStats     Type = 0x05
	TypeError     Type = 0x06
	TypeEvent     Type = 0x07
	TypeThumbnail Type = 0x08
	// Agent → helper (agent.go).
	TypeMenuClick     Type = 0x09
	TypeHotkey        Type = 0x0a
	TypeHotkeysBound  Type = 0x0b
	TypeNotifications Type = 0x0c
	// Helper → sidecar.
	TypeConfig   Type = 0x20
	TypeKeyframe Type = 0x21
	TypeBitrate  Type = 0x22
	TypeFPS      Type = 0x23
	TypeStop     Type = 0x24
	TypeCurtain  Type = 0x25
	// Helper → agent (agent.go).
	TypeMenu    Type = 0x26
	TypeNotify  Type = 0x27
	TypeHotkeys Type = 0x28
)

// ProtocolVersion is the version in hello; the helper refuses a sidecar of another one.
// Version 2 added the privacy curtain and the agent's messages.
const ProtocolVersion = 2

// MaxMessageSize is the largest message either side accepts.
const MaxMessageSize = 32 << 20

// Message is one message off the wire.
type Message struct {
	Type    Type
	Payload []byte
}

// ErrMessageSize is a length of 0 or above MaxMessageSize.
var ErrMessageSize = errors.New("sidecar: bad message length")

// Write writes one message.
func Write(w io.Writer, t Type, payload []byte) error {
	buf := make([]byte, 5+len(payload))
	binary.BigEndian.PutUint32(buf, uint32(1+len(payload)))
	buf[4] = byte(t)
	copy(buf[5:], payload)
	_, err := w.Write(buf)
	return err
}

// WriteJSON writes a JSON message.
func WriteJSON(w io.Writer, t Type, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return Write(w, t, b)
}

// Read reads one message.
func Read(r io.Reader) (Message, error) {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return Message{}, err
	}
	n := binary.BigEndian.Uint32(head[:])
	if n == 0 || n > MaxMessageSize {
		return Message{}, fmt.Errorf("%w: %d", ErrMessageSize, n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return Message{}, err
	}
	return Message{Type: Type(body[0]), Payload: body[1:]}, nil
}

// Decode unmarshals a JSON payload.
func (m Message) Decode(v any) error {
	if err := json.Unmarshal(m.Payload, v); err != nil {
		return fmt.Errorf("sidecar: message 0x%02x: %w", byte(m.Type), err)
	}
	return nil
}

// VideoHeaderSize is the size of a video message's header.
const VideoHeaderSize = 14

// keyframeFlag is bit 0 of a video message's flags.
const keyframeFlag = 1

// Video is a video message: one access unit (H.264 Annex B) of a layer.
type Video struct {
	// Layer is the index in Config.Layers.
	Layer    int
	Keyframe bool
	// PTSNanos is the capture time on the host clock.
	PTSNanos     uint64
	EncodeMicros uint32
	Data         []byte
}

// ParseVideo splits a video message's payload. Data aliases the payload.
func ParseVideo(p []byte) (Video, error) {
	if len(p) < VideoHeaderSize {
		return Video{}, fmt.Errorf("sidecar: video message of %d bytes", len(p))
	}
	return Video{
		Layer:        int(p[0]),
		Keyframe:     p[1]&keyframeFlag != 0,
		PTSNanos:     binary.BigEndian.Uint64(p[2:]),
		EncodeMicros: binary.BigEndian.Uint32(p[10:]),
		Data:         p[VideoHeaderSize:],
	}, nil
}

// Payload is the message payload of v (the fake sidecar in tests sends these).
func (v Video) Payload() []byte {
	p := make([]byte, VideoHeaderSize+len(v.Data))
	p[0] = byte(v.Layer)
	if v.Keyframe {
		p[1] = keyframeFlag
	}
	binary.BigEndian.PutUint64(p[2:], v.PTSNanos)
	binary.BigEndian.PutUint32(p[10:], v.EncodeMicros)
	copy(p[VideoHeaderSize:], v.Data)
	return p
}

// AudioHeaderSize is the size of an audio message's header.
const AudioHeaderSize = 12

// Audio is an audio message: one Opus packet.
type Audio struct {
	PTSNanos       uint64
	DurationMicros uint32
	Data           []byte
}

// ParseAudio splits an audio message's payload. Data aliases the payload.
func ParseAudio(p []byte) (Audio, error) {
	if len(p) < AudioHeaderSize {
		return Audio{}, fmt.Errorf("sidecar: audio message of %d bytes", len(p))
	}
	return Audio{
		PTSNanos:       binary.BigEndian.Uint64(p),
		DurationMicros: binary.BigEndian.Uint32(p[8:]),
		Data:           p[AudioHeaderSize:],
	}, nil
}

// Payload is the message payload of a.
func (a Audio) Payload() []byte {
	p := make([]byte, AudioHeaderSize+len(a.Data))
	binary.BigEndian.PutUint64(p, a.PTSNanos)
	binary.BigEndian.PutUint32(p[8:], a.DurationMicros)
	copy(p[AudioHeaderSize:], a.Data)
	return p
}

// KeyframePayload asks layer's encoder for an IDR now.
func KeyframePayload(layer int) []byte { return []byte{byte(layer)} }

// BitratePayload sets layer's bitrate live.
func BitratePayload(layer, kbps int) []byte {
	p := make([]byte, 5)
	p[0] = byte(layer)
	binary.BigEndian.PutUint32(p[1:], uint32(kbps))
	return p
}

// FPSPayload sets layer's frame rate.
func FPSPayload(layer, fps int) []byte {
	p := make([]byte, 3)
	p[0] = byte(layer)
	binary.BigEndian.PutUint16(p[1:], uint16(fps))
	return p
}

// CurtainPayload turns the privacy curtain on or off.
func CurtainPayload(on bool) []byte {
	if on {
		return []byte{1}
	}
	return []byte{0}
}

// ParseControl reads a control message (the fake sidecar in tests): the layer and the
// value (kbps or fps; 0 for a key frame; 1 or 0 for the curtain, with layer 0).
func ParseControl(m Message) (layer, value int, err error) {
	p := m.Payload
	switch m.Type {
	case TypeKeyframe:
		if len(p) < 1 {
			return 0, 0, errors.New("sidecar: short keyframe")
		}
		return int(p[0]), 0, nil
	case TypeBitrate:
		if len(p) < 5 {
			return 0, 0, errors.New("sidecar: short bitrate")
		}
		return int(p[0]), int(binary.BigEndian.Uint32(p[1:])), nil
	case TypeFPS:
		if len(p) < 3 {
			return 0, 0, errors.New("sidecar: short fps")
		}
		return int(p[0]), int(binary.BigEndian.Uint16(p[1:])), nil
	case TypeCurtain:
		if len(p) < 1 {
			return 0, 0, errors.New("sidecar: short curtain")
		}
		return 0, int(p[0] & 1), nil
	}
	return 0, 0, fmt.Errorf("sidecar: 0x%02x is not a control message", byte(m.Type))
}

// Hello is the sidecar's first message.
type Hello struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Version         string `json:"version"`
	OS              string `json:"os"`
}

// LayerConfig is one layer to encode.
type LayerConfig struct {
	RID    string `json:"rid"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	FPS    int    `json:"fps"`
	Kbps   int    `json:"kbps"`
	// VBVMs is the data-rate window: no window of this length carries more than Kbps allows.
	VBVMs int `json:"vbvMs"`
}

// SourceRef is what to capture: a display (CGDirectDisplayID) or a window (CGWindowID).
type SourceRef struct {
	Kind string `json:"kind"`
	ID   uint32 `json:"id"`
}

// AudioConfig is the app whose audio is captured: by pid, else by bundle id.
type AudioConfig struct {
	PID      int    `json:"pid,omitempty"`
	BundleID string `json:"bundleId,omitempty"`
	Kbps     int    `json:"kbps,omitempty"`
}

// ThumbnailConfig asks for a JPEG of the capture every EveryMs, Width wide.
type ThumbnailConfig struct {
	Width   int `json:"width"`
	EveryMs int `json:"everyMs"`
}

// Config starts the capture. Layers are highest first; the first sets the capture size.
type Config struct {
	Source     SourceRef        `json:"source"`
	Layers     []LayerConfig    `json:"layers"`
	GOPSeconds float64          `json:"gopSeconds"`
	Cursor     bool             `json:"cursor"`
	Audio      *AudioConfig     `json:"audio,omitempty"`
	Thumbnail  *ThumbnailConfig `json:"thumbnail,omitempty"`
}

// AppInfo is an app as the sidecar names it.
type AppInfo struct {
	Name     string `json:"name"`
	BundleID string `json:"bundleId"`
	PID      int    `json:"pid"`
}

// Started answers the config once the capture runs.
type Started struct {
	Width    int      `json:"width"`
	Height   int      `json:"height"`
	Encoder  string   `json:"encoder"`
	AudioApp *AppInfo `json:"audioApp,omitempty"`
}

// LayerStats are one layer's numbers for the last second.
type LayerStats struct {
	RID    string `json:"rid"`
	Frames int    `json:"frames"`
	// Dropped frames went into the encoder and did not come out (its rate control skipped
	// them); Busy ones were due while the encoder had 3 in flight, and were skipped before it.
	Dropped     int     `json:"dropped"`
	Busy        int     `json:"busy"`
	Keyframes   int     `json:"keyframes"`
	Bytes       int     `json:"bytes"`
	EncodeMsAvg float64 `json:"encodeMsAvg"`
	EncodeMsMax float64 `json:"encodeMsMax"`
}

// Stats cover the second before they were sent.
type Stats struct {
	// Captured frames had new content; Idle ones did not (a still screen); Repeated are the
	// last frame encoded again to keep a floor rate or to carry a forced IDR.
	Captured          int          `json:"captured"`
	Idle              int          `json:"idle"`
	Repeated          int          `json:"repeated"`
	Dropped           int          `json:"dropped"`
	CaptureDelayMsAvg float64      `json:"captureDelayMsAvg"`
	CPUPercent        float64      `json:"cpuPercent"`
	Layers            []LayerStats `json:"layers"`
	AudioPackets      int          `json:"audioPackets"`
}

// Error is a sidecar failure; a fatal one ends the capture.
type Error struct {
	// Code: permission, source_not_found, encoder, audio, capture, protocol, usage.
	Code    string `json:"code"`
	Message string `json:"message"`
	Fatal   bool   `json:"fatal"`
}

func (e *Error) Error() string { return "capture sidecar: " + e.Message }

// Event tells about the source: "ended" (closed), "hidden" (minimized, off screen), "shown".
type Event struct {
	Event  string `json:"event"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}
