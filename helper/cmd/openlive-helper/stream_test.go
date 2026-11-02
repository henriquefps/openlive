// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/rtc"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

func gameLayers(t *testing.T) (media.Preset, []media.Layer) {
	t.Helper()
	preset, err := media.FindPreset("game")
	if err != nil {
		t.Fatal(err)
	}
	layers, err := preset.Layers(media.ParseLayers("f,h,q"))
	if err != nil {
		t.Fatal(err)
	}
	return preset, layers
}

func TestFitRoom(t *testing.T) {
	preset, layers := gameLayers(t)
	all := []protocol.Preset{protocol.PresetText, protocol.PresetGame, protocol.PresetMax}

	// 8000 + 3500 + 1000 + 128 audio = 12628, above the platform default of 12000: the
	// video is capped at 12000 - 128 and the publish says 12000.
	var cfg rtc.Config
	got, err := fitRoom(protocol.RoomSettings{MaxBitrateKbps: 12000, AllowedPresets: all}, preset, layers, true, &cfg)
	if err != nil || got != 12000 || cfg.Rate.MaxKbps != 11872 {
		t.Fatalf("fit 12000: %d, video %d, %v", got, cfg.Rate.MaxKbps, err)
	}

	cfg = rtc.Config{}
	got, err = fitRoom(protocol.RoomSettings{MaxBitrateKbps: 25000, AllowedPresets: all}, preset, layers, false, &cfg)
	if err != nil || got != 12500 || cfg.Rate.MaxKbps != 0 {
		t.Fatalf("fit 25000: %d, video %d, %v", got, cfg.Rate.MaxKbps, err)
	}

	// Below the layers' minimum bitrates: refused before publishing.
	_, err = fitRoom(protocol.RoomSettings{MaxBitrateKbps: 2000, AllowedPresets: all}, preset, layers, true, &rtc.Config{})
	if api.ErrorCode(err) != protocol.ErrorCodeBitrateNotAllowed || !strings.Contains(err.Error(), "at most 2000 kbit/s") {
		t.Fatalf("fit 2000: %v", err)
	}

	_, err = fitRoom(protocol.RoomSettings{MaxBitrateKbps: 12000, AllowedPresets: []protocol.Preset{protocol.PresetText}}, preset, layers, true, &rtc.Config{})
	if api.ErrorCode(err) != protocol.ErrorCodePresetNotAllowed {
		t.Fatalf("preset: %v", err)
	}
}

func TestExplain(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{&api.Error{Status: 403, Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeQuotaExhausted}}, "quota is used up"},
		{&api.Error{Status: 403, Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeStreamPermissionRequired}}, "may not stream"},
		{&api.Error{Status: 409, Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeHelperBusy}}, "already streams"},
		{&api.Error{Status: 403, Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeBitrateNotAllowed, Limit: new(6000)}}, "at most 6000 kbit/s"},
		{&api.ReplyError{Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeStreamLimitReached, Limit: new(5)}}, "maximum of 5 streams"},
		{&api.Error{Status: 401, Payload: protocol.ErrorPayload{Code: protocol.ErrorCodeUnauthenticated}}, "pair again"},
		{&api.CloseError{Code: protocol.CloseCodeKicked}, "removed from the room"},
	} {
		got := explain(tc.err)
		if !strings.Contains(got.Error(), tc.want) || !errors.Is(got, tc.err) {
			t.Errorf("explain(%v) = %q, want …%s… wrapping the original", tc.err, got, tc.want)
		}
	}
	plain := errors.New("disk full")
	if explain(plain) != plain || explain(nil) != nil {
		t.Error("errors without a code changed")
	}
}

func TestEncodedLayers(t *testing.T) {
	// The native preset on a 3440x1440 monitor, with an AV1 track: viewers get the H.264
	// layers at the monitor's aspect ratio, not the preset's 3840x2160.
	p := mustPreset(t, "2160p60")
	layers, err := p.Layers(media.AllRIDs)
	if err != nil {
		t.Fatal(err)
	}
	layers = media.WithAV1(media.FitLayers(layers, 3440, 1440), 65)
	got := encodedLayers(layers, 0, true)
	want := protocol.VideoLayers{
		{Rid: "f", Width: 3440, Height: 1440, FPS: 60, Kbps: 25000},
		{Rid: "h", Width: 1728, Height: 720, FPS: 60, Kbps: 3500},
		{Rid: "q", Width: 1152, Height: 480, FPS: 30, Kbps: 1000},
	}
	if got == nil || !reflect.DeepEqual(*got, want) {
		t.Fatalf("layers: %+v", got)
	}

	// The room's 25 Mbit/s cap (audio included) comes off the top layer, as fitRoom's does.
	got = encodedLayers(layers, 25000, true)
	if got == nil || (*got)[0].Kbps != 25000-(25000+3500+1000+audioKbps-25000) || (*got)[1].Kbps != 3500 {
		t.Fatalf("capped: %+v", got)
	}
	if encodedLayers(nil, 0, false) != nil {
		t.Fatal("no layers: want nil")
	}
}
