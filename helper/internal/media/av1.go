// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Codec is a video codec a layer is encoded with.
type Codec string

const (
	CodecH264 Codec = "h264"
	// CodecAV1 is published as a second track beside the H.264 one: the top layer only,
	// for the viewers whose browser decodes it.
	CodecAV1 Codec = "av1"
)

// An AV1 layer's bitrate as a share of the H.264 layer it mirrors, per mode:
// "AV1: save data" sends less than H.264 for a similar picture (AV1 needs ~30–40 % less
// bitrate at these sizes; 65 % is the assumption until the F3-style measurement on real
// content), "AV1: quality" as much as H.264 for a sharper one. packages/usage
// uses the same numbers (AV1_MODE_PERCENT).
const (
	AV1SavePercent    = 65
	AV1QualityPercent = 100
)

// AV1PercentFor is the AV1 track's share for a stream of preset in a room: AV1QualityPercent
// for the room's av1QualityPresets (protocol 1.17), AV1SavePercent otherwise (and without a
// room, or from a Worker before 1.17).
func AV1PercentFor(settings *protocol.RoomSettings, preset protocol.Preset) int {
	if settings != nil && slices.Contains(settings.Av1QualityPresets, preset) {
		return AV1QualityPercent
	}
	return AV1SavePercent
}

// av1RIDPrefix marks an AV1 layer's RID inside the helper: "af" mirrors f (and "ah", "aq"
// would mirror h and q). On the wire a simulcast AV1 track would use f, h and q (WireRID);
// inside the helper every layer has its own key (encoder and appsink names, the
// publisher's per-layer state).
const av1RIDPrefix = "a"

// VideoCodec is the layer's codec (H.264 when unset).
func (l Layer) VideoCodec() Codec {
	if l.Codec == "" {
		return CodecH264
	}
	return l.Codec
}

// IsAV1 reports whether the layer is on the AV1 track.
func (l Layer) IsAV1() bool { return l.Codec == CodecAV1 }

// WireRID is the RID the SFU and the viewers see: the layer's RID without the AV1 prefix.
func (l Layer) WireRID() string {
	if l.IsAV1() {
		return strings.TrimPrefix(l.RID, av1RIDPrefix)
	}
	return l.RID
}

// AV1RID is the helper's RID of the AV1 layer that mirrors the wire RID rid ("f" → "af").
func AV1RID(rid string) string { return av1RIDPrefix + rid }

// AV1Layers mirrors H.264 layers in AV1: the same sizes and frame rates at percent of the
// bitrates (AV1SavePercent or AV1QualityPercent, rounded to 100 kbit/s), the RIDs prefixed
// with "a".
func AV1Layers(layers []Layer, percent int) []Layer {
	out := make([]Layer, 0, len(layers))
	for _, l := range layers {
		if l.IsAV1() {
			continue
		}
		a := l
		a.Codec = CodecAV1
		a.RID = AV1RID(l.RID)
		a.Kbps = av1Kbps(l.Kbps, percent)
		a.MinKbps = av1Kbps(l.MinKbps, percent)
		out = append(out, a)
	}
	return out
}

func av1Kbps(kbps, percent int) int { return max(100, (kbps*percent+5000)/10000*100) }

// WithAV1 returns the H.264 layers followed by the AV1 track's one layer: the mirror of the
// top layer at percent (AV1Layers). Layers that already carry one get it anew, at percent. The SFU cannot switch layers inside an AV1 simulcast track (it does
// not negotiate the Dependency Descriptor), so an AV1 viewer gets the top layer and a lower
// one comes from the H.264 track.
func WithAV1(layers []Layer, percent int) []Layer {
	h264 := LayersOf(layers, CodecH264)
	if len(h264) == 0 {
		return h264
	}
	return append(h264, AV1Layers(h264[:1], percent)...)
}

// LayersOf keeps the layers of one codec, in order.
func LayersOf(layers []Layer, c Codec) []Layer {
	var out []Layer
	for _, l := range layers {
		if l.VideoCodec() == c {
			out = append(out, l)
		}
	}
	return out
}

// HasAV1 reports whether any layer is on the AV1 track.
func HasAV1(layers []Layer) bool { return len(LayersOf(layers, CodecAV1)) > 0 }

// AV1 encoders: the AV1 element of each hardware family. A stream's AV1 layers use the
// family of its H.264 encoder (NVENC → nvav1enc, VA-API → vaav1enc or vaav1lpenc), so
// --encoder picks both. x264 has no AV1 sibling here: a software AV1 encoder (svtav1enc,
// av1enc) does not hold 1080p60 next to the H.264 layers, so the CPU path stays H.264.
const (
	EncoderNVAV1 Encoder = "nvav1"
	// EncoderVAAV1 and EncoderVAAV1LowPower are implemented but untested: the development
	// machine has an NVIDIA card (as for VA-API H.264).
	EncoderVAAV1         Encoder = "va-av1"
	EncoderVAAV1LowPower Encoder = "va-av1-lp"
)

// av1Siblings maps an H.264 encoder to the AV1 encoder of its family.
var av1Siblings = map[Encoder]Encoder{
	EncoderNVENC:      EncoderNVAV1,
	EncoderVA:         EncoderVAAV1,
	EncoderVALowPower: EncoderVAAV1LowPower,
}

// IsAV1 reports whether the encoder makes AV1.
func (e Encoder) IsAV1() bool {
	return e == EncoderNVAV1 || e == EncoderVAAV1 || e == EncoderVAAV1LowPower
}

// AV1 is the AV1 encoder of a concrete H.264 encoder's family, false when the family has
// none (x264).
func (e Encoder) AV1() (Encoder, bool) {
	if e.IsAV1() {
		return e, true
	}
	a, ok := av1Siblings[e]
	return a, ok
}

// ResolveAV1 is the AV1 encoder a stream encoded with enc (a concrete H.264 encoder) uses,
// or why it has none. It is the family's sibling only (va → vaav1enc, va-lp → vaav1lpenc):
// the pipeline builds each AV1 layer with enc.AV1().
func ResolveAV1(enc Encoder, has func(element string) bool) (Encoder, error) {
	a, ok := enc.AV1()
	if !ok && enc == EncoderVideoToolbox {
		return "", errors.New("macOS has no hardware AV1 encoder (VideoToolbox encodes H.264 and HEVC): the stream stays H.264")
	}
	if !ok {
		return "", fmt.Errorf("no AV1 encoder with %s (AV1 needs NVENC on an RTX 40 or newer, or VA-API)", enc)
	}
	if has(encoderElements[a]) {
		return a, nil
	}
	if a == EncoderNVAV1 {
		return "", fmt.Errorf("nvav1enc is not available (AV1 NVENC needs an RTX 40 or newer, the NVIDIA driver and gst-plugins-bad nvcodec)")
	}
	return "", fmt.Errorf("%s is not available (a VA-API driver with AV1 encoding, or gst-plugins-bad va missing)", encoderElements[a])
}

// DetectAV1Encoders lists the AV1 encoders GStreamer has.
func DetectAV1Encoders(has func(element string) bool) []Encoder {
	var out []Encoder
	for _, e := range []Encoder{EncoderNVAV1, EncoderVAAV1, EncoderVAAV1LowPower} {
		if has(encoderElements[e]) {
			out = append(out, e)
		}
	}
	return out
}

// AV1Mode is the --av1 flag: whether a stream also publishes the AV1 track.
type AV1Mode string

const (
	// AV1Auto publishes it when the room allows AV1 for the preset (RoomSettings.av1Presets)
	// and the encoder family has an AV1 encoder.
	AV1Auto AV1Mode = "auto"
	// AV1On publishes it whatever the room says (development, measurements); the Worker
	// still refuses it where AV1 is not allowed.
	AV1On  AV1Mode = "on"
	AV1Off AV1Mode = "off"
)

// AV1Usage is the --av1 flag's help.
const AV1Usage = "auto (when the room allows AV1 for the preset and the GPU encodes it), on or off"

// ParseAV1Mode validates an --av1 value.
func ParseAV1Mode(s string) (AV1Mode, error) {
	switch m := AV1Mode(s); m {
	case AV1Auto, AV1On, AV1Off:
		return m, nil
	}
	return "", fmt.Errorf("unknown --av1 %q (want %s)", s, AV1Usage)
}

// AV1KeyHeader reports whether an AV1 temporal unit (OBUs with size fields, as av1parse hands
// them over) carries a sequence header, which a viewer joining on that key frame needs.
func AV1KeyHeader(tu []byte) bool {
	for i := 0; i < len(tu); {
		h := tu[i]
		typ, ext, hasSize := h>>3&0xf, h>>2&1, h>>1&1
		i += 1 + int(ext)
		if hasSize == 0 {
			return typ == obuSequenceHeader
		}
		size, n := leb128(tu[min(i, len(tu)):])
		if n == 0 {
			return false
		}
		if typ == obuSequenceHeader {
			return true
		}
		i += n + int(size)
	}
	return false
}

const obuSequenceHeader = 1

// leb128 reads an unsigned LEB128 value; n is 0 when b holds no complete one.
func leb128(b []byte) (v uint64, n int) {
	for i := 0; i < len(b) && i < 8; i++ {
		v |= uint64(b[i]&0x7f) << (7 * i)
		if b[i]&0x80 == 0 {
			return v, i + 1
		}
	}
	return 0, 0
}
