// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"runtime"
	"slices"
	"strings"

	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/store"
)

func runStatus(args []string, w io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	var c common
	c.register(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	printf := func(format string, a ...any) { _, _ = fmt.Fprintf(w, format, a...) }
	printf("openlive-helper %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	if media.GStreamerAvailable {
		found := media.DetectEncoders(media.HasElement)
		encoders := []string{"none"}
		if len(found) > 0 {
			encoders = encoders[:0]
			for _, e := range found {
				encoders = append(encoders, string(e))
			}
		}
		printf("GStreamer: yes; H.264 encoders: %s; Opus: %v\n", strings.Join(encoders, ", "), media.HasElement("opusenc"))
		if auto, err := media.ResolveEncoder(media.EncoderAuto, media.HasElement); err == nil {
			printf("Encoder (auto): %s\n", auto)
			if !auto.Hardware() {
				printf("Warning: no hardware H.264 encoder (NVENC or VA-API); x264 on the CPU will not hold 1080p60\n")
			}
		}
	} else if media.MacAvailable {
		printf("Capture: macOS sidecar (ScreenCaptureKit + VideoToolbox, encoder vt); test-stream needs GStreamer and is unavailable\n")
	} else {
		printf("GStreamer: not in this build (nogst); test-stream is unavailable\n")
	}

	dir, err := c.dir()
	if err != nil {
		return err
	}
	cfg, err := store.LoadConfig(store.ConfigPath(dir))
	if err != nil {
		return err
	}
	tokens, err := c.tokens()
	if err != nil {
		return err
	}
	printf("Config: %s\nTokens: %s\n", store.ConfigPath(dir), tokens.Name())
	if len(cfg.Instances) == 0 {
		printf("Paired instances: none (run openlive-helper pair --instance https://<your instance>)\n")
		return nil
	}
	printf("Paired instances:\n")
	var urls []string
	for u := range cfg.Instances {
		urls = append(urls, u)
	}
	slices.Sort(urls)
	for _, u := range urls {
		in := cfg.Instances[u]
		token := "token stored"
		if _, err := tokens.Get(u); errors.Is(err, store.ErrNoToken) {
			token = "no token: pair again"
		} else if err != nil {
			token = "token unreadable: " + err.Error()
		}
		mark := " "
		if u == cfg.DefaultInstance {
			mark = "*"
		}
		printf(" %s %s  device %s (%s), paired %s, %s\n", mark, u, in.DeviceID, in.DeviceName, in.PairedAt.Format("2006-01-02"), token)
	}
	return nil
}
