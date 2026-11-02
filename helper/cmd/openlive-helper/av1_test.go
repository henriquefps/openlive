// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"log/slog"
	"strings"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/rtc"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

func TestWithAV1Decision(t *testing.T) {
	preset, layers := gameLayers(t)
	nvidia := func(e string) bool { return e == "nvh264enc" || e == "nvav1enc" }
	olderNvidia := func(e string) bool { return e == "nvh264enc" }
	allowed := &protocol.RoomSettings{Av1Presets: []protocol.Preset{protocol.PresetGame}}
	other := &protocol.RoomSettings{Av1Presets: []protocol.Preset{protocol.PresetMax}}
	log := slog.New(slog.DiscardHandler)
	cases := []struct {
		name     string
		mode     media.AV1Mode
		settings *protocol.RoomSettings
		has      func(string) bool
		av1      bool
		err      string
	}{
		{"auto, allowed, RTX 40", media.AV1Auto, allowed, nvidia, true, ""},
		{"auto, another preset", media.AV1Auto, other, nvidia, false, ""},
		{"auto, no room (loopback)", media.AV1Auto, nil, nvidia, false, ""},
		{"auto, allowed, no AV1 encoder", media.AV1Auto, allowed, olderNvidia, false, ""},
		{"off", media.AV1Off, allowed, nvidia, false, ""},
		{"on, not allowed", media.AV1On, other, nvidia, true, ""},
		{"on, no AV1 encoder", media.AV1On, nil, olderNvidia, false, "nvav1enc is not available"},
	}
	for _, c := range cases {
		got, err := withAV1(c.mode, c.settings, preset, media.EncoderAuto, layers, c.has, log)
		if c.err != "" {
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Errorf("%s: err %v, want %q", c.name, err, c.err)
			}
			continue
		}
		if err != nil || media.HasAV1(got) != c.av1 || len(media.LayersOf(got, media.CodecH264)) != 3 {
			t.Errorf("%s: %d layers, AV1 %v, err %v; want AV1 %v", c.name, len(got), media.HasAV1(got), err, c.av1)
		}
	}
}

// TestWithAV1Mode: the AV1 layer's bitrate follows the preset's mode in the room
//: 65 % of the H.264 top layer to save data, 100 % for quality.
func TestWithAV1Mode(t *testing.T) {
	preset, layers := gameLayers(t)
	nvidia := func(e string) bool { return e == "nvh264enc" || e == "nvav1enc" }
	log := slog.New(slog.DiscardHandler)
	game := []protocol.Preset{protocol.PresetGame}
	for _, c := range []struct {
		name     string
		settings *protocol.RoomSettings
		kbps     int
	}{
		{"save data", &protocol.RoomSettings{Av1Presets: game}, 5200},
		{"quality", &protocol.RoomSettings{Av1Presets: game, Av1QualityPresets: game}, 8000},
	} {
		got, err := withAV1(media.AV1Auto, c.settings, preset, media.EncoderAuto, layers, nvidia, log)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if a := media.LayersOf(got, media.CodecAV1); len(a) != 1 || a[0].Kbps != c.kbps {
			t.Errorf("%s: AV1 layers %+v, want one at %d kbit/s", c.name, a, c.kbps)
		}
	}
}

// TestFitRoomWithAV1: the room's cap is the H.264 track's (and the publish's
// maxBitrateKbps); the AV1 track gets the same share of its own target on top.
func TestFitRoomWithAV1(t *testing.T) {
	preset, h264 := gameLayers(t)
	layers := media.WithAV1(h264, media.AV1SavePercent) // 12500 H.264 + 5200 AV1
	all := []protocol.Preset{protocol.PresetText, protocol.PresetGame, protocol.PresetMax}
	var cfg rtc.Config
	got, err := fitRoom(protocol.RoomSettings{MaxBitrateKbps: 13000, AllowedPresets: all}, preset, layers, true, &cfg)
	if err != nil || got != 12628 || cfg.Rate.MaxKbps != 0 {
		t.Fatalf("fit 13000: %d, video %d, %v", got, cfg.Rate.MaxKbps, err)
	}
	cfg = rtc.Config{}
	got, err = fitRoom(protocol.RoomSettings{MaxBitrateKbps: 12000, AllowedPresets: all}, preset, layers, true, &cfg)
	// 11872 for H.264, × 17700/12500 for both tracks.
	if err != nil || got != 12000 || cfg.Rate.MaxKbps != 11872*141/100 {
		t.Fatalf("fit 12000: %d, video %d, %v", got, cfg.Rate.MaxKbps, err)
	}
	if share := withAV1Share(h264); share != 100 {
		t.Errorf("share without AV1 %d", share)
	}
}
