// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"fmt"
	"slices"
	"strings"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Layer is one simulcast encoding. RIDs sort "asciibetically" from best to worst
// (f < h < q), the order the SFU's ridNotAvailable policy uses.
type Layer struct {
	RID    string
	Width  int
	Height int
	FPS    int
	// Kbps is the target bitrate; MinKbps is the lowest the rate controller may set.
	Kbps    int
	MinKbps int
	// VBV is the encoder's buffer, as time at Kbps (0: DefaultVBV). It bounds the size of
	// an IDR: at 8 Mbit/s on noise, 250 ms gave 176–202 KB IDRs and 125 ms ~70 KB. It is
	// fixed for the encoder's life (changing it makes NVENC emit an IDR).
	VBV time.Duration
	// Codec is the layer's codec; empty is H.264. AV1 layers mirror the H.264 ones on a
	// second track (AV1Layers) and carry an "a" before their RID inside the helper.
	Codec Codec
}

// DefaultVBV is the VBV of a layer that sets none.
const DefaultVBV = 250 * time.Millisecond

// vbvMillis is the layer's VBV in milliseconds.
func (l Layer) vbvMillis() int {
	if l.VBV <= 0 {
		return int(DefaultVBV.Milliseconds())
	}
	return int(l.VBV.Milliseconds())
}

// WithVBV returns the layers with their VBV set to d (0 keeps the default).
func WithVBV(layers []Layer, d time.Duration) []Layer {
	out := slices.Clone(layers)
	for i := range out {
		out[i].VBV = d
	}
	return out
}

// Preset is a named top layer plus the protocol preset the room shows.
type Preset struct {
	Name     string
	Aliases  []string
	Protocol protocol.Preset
	Top      Layer
}

// Presets are the qualities the helper offers: the 60 fps ones lowest first, then the
// 120 fps ones (top layer only). The top layer follows the quality table; the h and q
// layers are fixed at 720p60 / 480p30, so only the top layer runs at 120.
var Presets = []Preset{
	{Name: "1080p30", Aliases: []string{"text"}, Protocol: protocol.PresetText,
		Top: Layer{RID: "f", Width: 1920, Height: 1080, FPS: 30, Kbps: 6000, MinKbps: 1500}},
	{Name: "1080p60", Aliases: []string{"game"}, Protocol: protocol.PresetGame,
		Top: Layer{RID: "f", Width: 1920, Height: 1080, FPS: 60, Kbps: 8000, MinKbps: 2000}},
	{Name: "1440p60", Aliases: []string{"max"}, Protocol: protocol.PresetMax,
		Top: Layer{RID: "f", Width: 2560, Height: 1440, FPS: 60, Kbps: 12000, MinKbps: 3000}},
	{Name: "2160p60", Aliases: []string{"native"}, Protocol: protocol.PresetNative,
		Top: Layer{RID: "f", Width: 3840, Height: 2160, FPS: 60, Kbps: 25000, MinKbps: 5000}},
	{Name: "1080p120", Aliases: []string{"game120"}, Protocol: protocol.PresetGame120,
		Top: Layer{RID: "f", Width: 1920, Height: 1080, FPS: 120, Kbps: 14000, MinKbps: 3500}},
	{Name: "1440p120", Aliases: []string{"max120"}, Protocol: protocol.PresetMax120,
		Top: Layer{RID: "f", Width: 2560, Height: 1440, FPS: 120, Kbps: 20000, MinKbps: 5000}},
}

// MaxFPS is the highest frame rate any preset captures (a
// fixed ceiling, also on faster monitors).
const MaxFPS = 120

// DefaultPreset is used when none is given.
const DefaultPreset = "1080p60"

var (
	layerH = Layer{RID: "h", Width: 1280, Height: 720, FPS: 60, Kbps: 3500, MinKbps: 1000}
	layerQ = Layer{RID: "q", Width: 854, Height: 480, FPS: 30, Kbps: 1000, MinKbps: 300}
)

// AllRIDs are the simulcast layers in order, highest first.
var AllRIDs = []string{"f", "h", "q"}

// FindPreset looks a preset up by name or alias, ignoring case.
func FindPreset(name string) (Preset, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, p := range Presets {
		if p.Name == name || slices.Contains(p.Aliases, name) {
			return p, nil
		}
	}
	var names []string
	for _, p := range Presets {
		names = append(names, p.Name)
	}
	return Preset{}, fmt.Errorf("unknown preset %q (want one of %s)", name, strings.Join(names, ", "))
}

// Layers returns the preset's simulcast layers for the given RIDs, highest first.
// The h layer never runs faster than the top layer.
func (p Preset) Layers(rids []string) ([]Layer, error) {
	if len(rids) == 0 {
		return nil, fmt.Errorf("at least one layer is required")
	}
	h := layerH
	h.FPS = min(h.FPS, p.Top.FPS)
	all := map[string]Layer{"f": p.Top, "h": h, "q": layerQ}
	var out []Layer
	for _, rid := range AllRIDs {
		if slices.Contains(rids, rid) {
			out = append(out, all[rid])
		}
	}
	for _, rid := range rids {
		if _, ok := all[rid]; !ok {
			return nil, fmt.Errorf("unknown layer %q (want f, h or q)", rid)
		}
	}
	return out, nil
}

// ParseLayers parses "f,h,q".
func ParseLayers(s string) []string {
	var out []string
	for part := range strings.SplitSeq(s, ",") {
		if part = strings.ToLower(strings.TrimSpace(part)); part != "" && !slices.Contains(out, part) {
			out = append(out, part)
		}
	}
	return out
}
