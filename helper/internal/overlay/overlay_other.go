// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package overlay

import (
	"errors"
	"log/slog"
)

// errUnsupported: the macOS overlay is a later phase.
var errUnsupported = errors.New("pointer pings are not drawn on this system yet")

// Probe reports no overlay outside Linux.
func Probe() Support { return Support{Err: errUnsupported} }

// Open fails outside Linux.
func Open(*slog.Logger) (Drawer, error) { return nil, errUnsupported }
