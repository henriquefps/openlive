// SPDX-License-Identifier: AGPL-3.0-only

//go:build nogst || darwin

package media

import "context"

// GStreamerAvailable is false in builds with the nogst tag (CI without GStreamer) and on
// macOS, which captures and encodes through its sidecar instead (macos.go).
const GStreamerAvailable = false

// GStreamerVersion is empty without GStreamer.
func GStreamerVersion() string { return "" }

// HasElement always reports false without GStreamer.
func HasElement(string) bool { return false }

// TestBackend is unavailable in this build.
type TestBackend struct {
	Image string
	Label string
}

// NewTestBackend fails in builds without GStreamer.
func NewTestBackend() (*TestBackend, error) { return nil, ErrUnavailable }

// ListSources fails in builds without GStreamer.
func (*TestBackend) ListSources(context.Context) ([]Source, error) { return nil, ErrUnavailable }

// Start fails in builds without GStreamer.
func (*TestBackend) Start(context.Context, Source, Profile) (Stream, error) {
	return nil, ErrUnavailable
}
