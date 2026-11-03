// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"strings"
	"testing"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

func gameLayers(t *testing.T) []Layer {
	t.Helper()
	p, err := FindPreset("1080p60")
	if err != nil {
		t.Fatal(err)
	}
	layers, err := p.Layers(AllRIDs)
	if err != nil {
		t.Fatal(err)
	}
	return layers
}

func TestWithAV1(t *testing.T) {
	layers := WithAV1(gameLayers(t), AV1SavePercent)
	if len(layers) != 4 {
		t.Fatalf("%d layers, want f, h, q and the AV1 top layer", len(layers))
	}
	a := layers[3]
	if a.RID != "af" || a.WireRID() != "f" || !a.IsAV1() || a.VideoCodec() != CodecAV1 {
		t.Fatalf("AV1 layer %+v", a)
	}
	// 65 % of 8000 / 2000, same size and rate.
	if a.Kbps != 5200 || a.MinKbps != 1300 || a.Width != 1920 || a.Height != 1080 || a.FPS != 60 {
		t.Fatalf("AV1 layer %+v", a)
	}
	if got := LayersOf(layers, CodecH264); len(got) != 3 || got[0].RID != "f" || got[0].WireRID() != "f" {
		t.Fatalf("H.264 layers %+v", got)
	}
	if !HasAV1(layers) || HasAV1(gameLayers(t)) {
		t.Fatal("HasAV1")
	}
	// Idempotent: a preset change re-applies it to layers that may carry the AV1 one.
	if again := WithAV1(layers, AV1SavePercent); len(again) != 4 || again[3].RID != "af" {
		t.Fatalf("WithAV1 twice: %+v", again)
	}
	if AV1RID("h") != "ah" {
		t.Fatal("AV1RID")
	}
}

// TestWithAV1Quality: the quality mode mirrors the top layer at the H.264
// bitrate; re-applying WithAV1 with another mode replaces the AV1 layer.
func TestWithAV1Quality(t *testing.T) {
	layers := WithAV1(gameLayers(t), AV1QualityPercent)
	a := layers[3]
	if len(layers) != 4 || a.RID != "af" || a.Kbps != 8000 || a.MinKbps != 2000 {
		t.Fatalf("AV1 layer %+v", a)
	}
	save := WithAV1(layers, AV1SavePercent)
	if len(save) != 4 || save[3].Kbps != 5200 || save[3].MinKbps != 1300 {
		t.Fatalf("back to saving data: %+v", save)
	}
}

func TestAV1PercentFor(t *testing.T) {
	quality := &protocol.RoomSettings{
		Av1Presets:        []protocol.Preset{protocol.PresetText, protocol.PresetGame},
		Av1QualityPresets: []protocol.Preset{protocol.PresetGame},
	}
	cases := []struct {
		settings *protocol.RoomSettings
		preset   protocol.Preset
		want     int
	}{
		{quality, protocol.PresetGame, AV1QualityPercent},
		{quality, protocol.PresetText, AV1SavePercent},
		// A Worker before 1.17 sends no av1QualityPresets; without a room (loopback) neither.
		{&protocol.RoomSettings{Av1Presets: []protocol.Preset{protocol.PresetGame}}, protocol.PresetGame, AV1SavePercent},
		{nil, protocol.PresetGame, AV1SavePercent},
	}
	for _, c := range cases {
		if got := AV1PercentFor(c.settings, c.preset); got != c.want {
			t.Errorf("AV1PercentFor(%v, %s) = %d, want %d", c.settings, c.preset, got, c.want)
		}
	}
	if AV1SavePercent != 65 || AV1QualityPercent != 100 {
		t.Fatal("the modes' percents differ from packages/usage AV1_MODE_PERCENT")
	}
}

func TestAV1Kbps(t *testing.T) {
	for in, want := range map[int]int{8000: 5200, 3500: 2300, 1000: 700, 300: 200, 100: 100, 25000: 16300} {
		if got := av1Kbps(in, AV1SavePercent); got != want {
			t.Errorf("av1Kbps(%d) = %d, want %d", in, got, want)
		}
	}
	for in, want := range map[int]int{8000: 8000, 2000: 2000, 25000: 25000, 50: 100} {
		if got := av1Kbps(in, AV1QualityPercent); got != want {
			t.Errorf("av1Kbps(%d, quality) = %d, want %d", in, got, want)
		}
	}
}

func TestResolveAV1(t *testing.T) {
	has := func(elements ...string) func(string) bool {
		return func(e string) bool {
			for _, x := range elements {
				if x == e {
					return true
				}
			}
			return false
		}
	}
	cases := []struct {
		enc     Encoder
		has     []string
		want    Encoder
		wantErr string
	}{
		{EncoderNVENC, []string{"nvav1enc"}, EncoderNVAV1, ""},
		{EncoderNVENC, nil, "", "RTX 40"},
		{EncoderVA, []string{"vaav1enc"}, EncoderVAAV1, ""},
		// The sibling only: the AV1 layer is built with the H.264 encoder's family.
		{EncoderVA, []string{"vaav1lpenc"}, "", "vaav1enc is not available"},
		{EncoderVALowPower, []string{"vaav1lpenc"}, EncoderVAAV1LowPower, ""},
		{EncoderX264, []string{"nvav1enc", "vaav1enc"}, "", "no AV1 encoder with x264"},
	}
	for _, c := range cases {
		got, err := ResolveAV1(c.enc, has(c.has...))
		if got != c.want || (c.wantErr == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), c.wantErr)) {
			t.Errorf("ResolveAV1(%s, %v) = %q, %v; want %q, %q", c.enc, c.has, got, err, c.want, c.wantErr)
		}
	}
	if got := DetectAV1Encoders(has("nvav1enc", "vaav1lpenc")); len(got) != 2 || got[0] != EncoderNVAV1 || got[1] != EncoderVAAV1LowPower {
		t.Errorf("DetectAV1Encoders = %v", got)
	}
}

func TestAV1EncoderElement(t *testing.T) {
	a := WithAV1(gameLayers(t), AV1SavePercent)[3]
	nv, err := encoderElement(EncoderNVENC, a, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// For AV1: CBR, low-latency tuning, no B-frames, the fixed VBV (250 ms of 5200
	// kbit/s), a 10 s GOP, named by the layer's RID.
	for _, want := range []string{"nvav1enc name=enc_af ", "rc-mode=cbr", "tune=ultra-low-latency", "bitrate=5200", "vbv-buffer-size=1300", "gop-size=600", "bframes=0", "zerolatency=true", "video/x-av1,profile=main"} {
		if !strings.Contains(nv, want) {
			t.Errorf("nvav1enc: %q lacks %q", nv, want)
		}
	}
	va, err := encoderElement(EncoderVA, a, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"vaav1enc name=enc_af ", "rate-control=cbr", "cpb-size=1300", "key-int-max=1024", "target-usage=7"} {
		if !strings.Contains(va, want) {
			t.Errorf("vaav1enc: %q lacks %q", va, want)
		}
	}
	if lp, _ := encoderElement(EncoderVALowPower, a, time.Second); !strings.HasPrefix(lp, "vaav1lpenc ") {
		t.Errorf("va-lp family: %q", lp)
	}
	if _, err := encoderElement(EncoderX264, a, time.Second); err == nil {
		t.Error("x264 has no AV1 sibling, want an error")
	}
	if _, err := encoderElement(EncoderNVAV1, gameLayers(t)[0], time.Second); err == nil {
		t.Error("an AV1 encoder on an H.264 layer, want an error")
	}
}

func TestAV1Pipelines(t *testing.T) {
	layers := WithAV1(gameLayers(t), AV1SavePercent)
	desc, err := linuxPipelineDescription(PathGL, layers, EncoderNVENC, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// The AV1 branch: the GL mixer's frame through cudaupload into nvav1enc, then av1parse in
	// OBU stream, one temporal unit per buffer, into its own appsink.
	branch := desc[strings.Index(desc, "nvav1enc"):]
	for _, want := range []string{"av1parse ! video/x-av1,stream-format=obu-stream,alignment=tu", "appsink name=sink_af "} {
		if !strings.Contains(branch, want) {
			t.Errorf("AV1 branch lacks %q: %s", want, branch)
		}
	}
	if strings.Count(desc, "cudaupload") != 4 || strings.Count(desc, "h264parse") != 3 || strings.Count(desc, "nvh264enc") != 3 {
		t.Errorf("want 4 CUDA uploads, 3 H.264 encoders and parsers: %s", desc)
	}
	test, err := testPipelineDescription(layers, EncoderNVENC, 10*time.Second, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(test, "nvav1enc name=enc_af") || !strings.Contains(test, "appsink name=sink_af") {
		t.Errorf("test pipeline: %s", test)
	}
}

func TestAV1KeyHeader(t *testing.T) {
	obu := func(typ byte, payload ...byte) []byte {
		return append([]byte{typ<<3 | 0b10, byte(len(payload))}, payload...)
	}
	key := append(append(obu(2), obu(1, 0, 0, 0)...), obu(6, 1, 2, 3)...)
	delta := append(obu(2), obu(6, 1, 2, 3)...)
	if !AV1KeyHeader(key) {
		t.Error("key frame with a sequence header: not found")
	}
	if AV1KeyHeader(delta) || AV1KeyHeader(nil) || AV1KeyHeader([]byte{0x12, 0x80}) {
		t.Error("found a sequence header where there is none")
	}
}

func TestParseAV1Mode(t *testing.T) {
	for _, s := range []string{"auto", "on", "off"} {
		if m, err := ParseAV1Mode(s); err != nil || string(m) != s {
			t.Errorf("%s: %v", s, err)
		}
	}
	if _, err := ParseAV1Mode("yes"); err == nil {
		t.Error("yes: want an error")
	}
}
