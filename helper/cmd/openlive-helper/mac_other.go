// SPDX-License-Identifier: AGPL-3.0-only

//go:build !unix

package main

import (
	"errors"
	"io"
	"log/slog"

	"github.com/henriquefps/openlive/helper/internal/media"
)

// The macOS backend needs a unix (mac.go); these keep other builds compiling.

type macFlags struct {
	hideCursor  bool
	testPattern string
	testSize    string
	audioApp    string
}

func macScreen(macFlags, *slog.Logger) (func(string) (media.MediaBackend, error), media.Thumbnailer, error) {
	return nil, nil, media.ErrUnavailable
}

func runMacStream(*captureFlags) error { return errors.New("macOS capture is not in this build") }

func macDoctor(io.Writer) error { return nil }

func startAsApp() error { return errNotApp }
