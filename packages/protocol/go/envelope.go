// SPDX-License-Identifier: AGPL-3.0-only

// Package protocol holds the Openlive WebSocket protocol types for Go (the helper).
//
// The types in protocol_gen.go are generated from packages/protocol/schema by
// packages/protocol/scripts/generate.ts; docs/PROTOCOL.md is the human-readable contract.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Payload is implemented by every generated payload type.
type Payload interface {
	Type() MessageType
}

// MessageInfo is the catalogue metadata of a message type.
type MessageInfo struct {
	Phase    int
	Channels []string
	From     []string
	To       []string
	Replies  []MessageType
}

// Envelope is the shape of every WebSocket frame.
type Envelope struct {
	Type    MessageType     `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload"`
}

// ErrUnknownType is returned by Decode for a well-formed envelope whose type this version
// doesn't know. Receivers ignore such messages (or answer unknown_message_type when the
// message carries an id).
var ErrUnknownType = errors.New("protocol: unknown message type")

// Encode builds a frame for p. id may be empty.
func Encode(id string, p Payload) ([]byte, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Envelope{Type: p.Type(), ID: id, Payload: raw})
}

// Decode parses a frame. Unknown fields are ignored, as PROTOCOL.md requires of receivers.
// For an unknown type it returns the envelope and ErrUnknownType.
func Decode(data []byte) (Envelope, Payload, error) {
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return env, nil, fmt.Errorf("protocol: invalid envelope: %w", err)
	}
	if env.Type == "" || len(env.Payload) == 0 {
		return env, nil, errors.New("protocol: invalid envelope: type and payload are required")
	}
	p := NewPayload(env.Type)
	if p == nil {
		return env, nil, ErrUnknownType
	}
	if err := json.Unmarshal(env.Payload, p); err != nil {
		return env, nil, fmt.Errorf("protocol: invalid %s payload: %w", env.Type, err)
	}
	return env, p, nil
}
