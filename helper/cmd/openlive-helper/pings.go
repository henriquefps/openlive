// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"log/slog"

	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/overlay"
)

// overlaySupported is overlay.Supported; tests replace it.
var overlaySupported = overlay.Supported

// newPings returns the drawer of a stream's pointer pings (PROTOCOL.md §7.9), or nil when
// this stream cannot have them: no overlay on this desktop (X11, a compositor without the
// wlr layer shell, macOS for now) or a capture that cannot map a ping back to the screen.
// Nil means stream.announce says pingOverlay=false, so the room never enables pings.
func newPings(log *slog.Logger, target func() (overlay.Target, bool)) *overlay.Controller {
	t, ok := target()
	if !ok {
		return nil
	}
	if _, _, ok := t.PingSource(); !ok {
		return nil
	}
	if !overlaySupported() {
		log.Info("pointer pings: no overlay on this desktop (Wayland with the wlr layer shell is needed)")
		return nil
	}
	return overlay.NewController(log, target)
}

// pingTarget is the stream as a ping target, when its capture is one (the Linux backend).
func pingTarget(s media.Stream) func() (overlay.Target, bool) {
	return func() (overlay.Target, bool) {
		t, ok := s.(overlay.Target)
		return t, ok
	}
}
