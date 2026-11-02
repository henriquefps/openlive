// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux || nogst

package media

import (
	"context"
	"log/slog"
	"time"

	"github.com/henriquefps/openlive/helper/internal/audio"
	"github.com/henriquefps/openlive/helper/internal/portal"
)

// LinuxAvailable is false where the Linux capture backend is not built.
const LinuxAvailable = false

// LinuxOptions configure the Linux backend (see linux_gst.go).
type LinuxOptions struct {
	Store                 portal.Store
	Pick                  bool
	WindowHint            string
	AudioApp              string
	StillPause            time.Duration
	Path                  CapturePath
	HideCursor            bool
	TestPattern           string
	TestWidth, TestHeight int
	StartAudio            audio.Starter
	Log                   *slog.Logger
}

// LinuxBackend is unavailable in this build.
type LinuxBackend struct{}

// NewLinuxBackend fails outside Linux builds with GStreamer.
func NewLinuxBackend(LinuxOptions) (*LinuxBackend, error) { return nil, ErrUnavailable }

// ListSources fails in this build.
func (*LinuxBackend) ListSources(context.Context) ([]Source, error) { return nil, ErrUnavailable }

// Start fails in this build.
func (*LinuxBackend) Start(context.Context, Source, Profile) (Stream, error) {
	return nil, ErrUnavailable
}
