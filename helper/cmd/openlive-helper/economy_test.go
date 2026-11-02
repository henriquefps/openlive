// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"slices"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/media"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Economy mode: the preset and bitrate a capped stream runs.

var economy = &protocol.QualityCap{MaxHeight: 1080, MaxBitrateKbps: 8000}

func mustPreset(t *testing.T, name string) media.Preset {
	t.Helper()
	p, err := media.FindPreset(name)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCapPreset(t *testing.T) {
	all := []protocol.Preset{protocol.PresetText, protocol.PresetGame, protocol.PresetMax, protocol.PresetNative}
	all120 := append(slices.Clone(all), protocol.PresetGame120, protocol.PresetMax120)
	for _, c := range []struct {
		allowed []protocol.Preset
		chosen  string
		cap     *protocol.QualityCap
		want    string
	}{
		{all, "1440p60", nil, "1440p60"},
		{all, "1440p60", economy, "1080p60"},
		{all, "2160p60", economy, "1080p60"},
		{all, "1080p60", economy, "1080p60"},
		// Never above the streamer's choice.
		{all, "1080p30", economy, "1080p30"},
		// Only allowed presets.
		{[]protocol.Preset{protocol.PresetText, protocol.PresetMax}, "1440p60", economy, "1080p30"},
		// Nothing fits: keep the choice (the bitrate cap still applies).
		{all, "1440p60", &protocol.QualityCap{MaxHeight: 720, MaxBitrateKbps: 3000}, "1440p60"},
		// Economy never keeps 120 fps: it doubles the egress.
		{all120, "1440p120", economy, "1080p60"},
		{all120, "1080p120", economy, "1080p60"},
		{all120, "1440p120", nil, "1440p120"},
	} {
		got := capPreset(c.allowed, mustPreset(t, c.chosen), c.cap)
		if got.Name != c.want {
			t.Errorf("capPreset(%v, %s, %v) = %s, want %s", c.allowed, c.chosen, c.cap, got.Name, c.want)
		}
	}
}

func TestCapLayers(t *testing.T) {
	layers, err := mustPreset(t, "1080p60").Layers(media.AllRIDs)
	if err != nil {
		t.Fatal(err)
	}
	if got := capLayers(layers, nil, true); got[0].Kbps != 8000 {
		t.Fatalf("without a cap: %d", got[0].Kbps)
	}
	got := capLayers(layers, economy, true)
	// The top layer leaves room for the audio; the lower ones are already under the cap.
	if got[0].Kbps != 8000-audioKbps || got[1].Kbps != 3500 || got[2].Kbps != 1000 {
		t.Fatalf("capped: %+v", got)
	}
	if got[0].MinKbps > got[0].Kbps {
		t.Fatalf("min above target: %+v", got[0])
	}
	if layers[0].Kbps != 8000 {
		t.Fatal("capLayers changed its input")
	}
	running := []media.Layer{{RID: "f", Width: 2576, Height: 1080, Kbps: 1}, {RID: "h", Width: 1728, Height: 720, Kbps: 1}}
	merged := withTargets(running, layers)
	if merged[0].Width != 2576 || merged[0].Kbps != 8000 || merged[1].Kbps != 3500 {
		t.Fatalf("withTargets: %+v", merged)
	}
}

func TestSameCap(t *testing.T) {
	other := *economy
	if !sameCap(nil, nil) || !sameCap(economy, &other) || sameCap(economy, nil) || sameCap(nil, economy) {
		t.Fatal("sameCap")
	}
}
