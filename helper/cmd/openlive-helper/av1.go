// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"log/slog"
	"slices"

	"github.com/henriquefps/openlive/helper/internal/media"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// AV1: a stream publishes its H.264 layers and, when the room allows AV1 for
// its preset and the GPU encodes it, its top layer in AV1 on a second track, at the bitrate of
// the preset's mode (save data or quality). The choice is made once, at the
// start: a preset change keeps the tracks the publication has, at the new preset's mode.

// withAV1 adds the AV1 track's layer when mode and the room say so. settings is nil
// without a room (--loopback). enc is the --encoder choice; has finds GStreamer elements.
// "on" fails when the encoder has no AV1 sibling; "auto" logs it and stays on H.264.
func withAV1(mode media.AV1Mode, settings *protocol.RoomSettings, preset media.Preset, enc media.Encoder, layers []media.Layer, has func(string) bool, log *slog.Logger) ([]media.Layer, error) {
	switch mode {
	case media.AV1Off:
		return layers, nil
	case media.AV1Auto:
		if settings == nil || !slices.Contains(settings.Av1Presets, preset.Protocol) {
			return layers, nil
		}
	}
	concrete, err := media.ResolveEncoder(enc, has)
	if err == nil {
		_, err = media.ResolveAV1(concrete, has)
	}
	if err != nil {
		if mode == media.AV1On {
			return nil, fmt.Errorf("--av1 on: %w", err)
		}
		log.Info("the room allows AV1 for this preset, but this machine does not encode it: H.264 only", "reason", err)
		return layers, nil
	}
	return media.WithAV1(layers, media.AV1PercentFor(settings, preset.Protocol)), nil
}

// av1Layers is withAV1 for test-stream and stream: with "auto" it reads the room's settings
// first (the publish reads them again).
func (f *streamFlags) av1Layers(ctx context.Context, preset media.Preset, layers []media.Layer, enc media.Encoder, log *slog.Logger) ([]media.Layer, error) {
	mode, err := media.ParseAV1Mode(f.av1)
	if err != nil {
		return nil, err
	}
	var settings *protocol.RoomSettings
	if mode == media.AV1Auto && !f.loopback {
		client, _, err := f.paired()
		if err != nil {
			return nil, err
		}
		s, err := client.RoomSettings(ctx, f.room)
		if err != nil {
			return nil, fmt.Errorf("room %s: %w", f.room, err)
		}
		settings = &s
	}
	return withAV1(mode, settings, preset, enc, layers, media.HasElement, log)
}
