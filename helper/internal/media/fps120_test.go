// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"strings"
	"testing"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The 120 fps presets run only their top layer at 120.
func TestPresets120(t *testing.T) {
	for _, c := range []struct {
		name, alias string
		proto       protocol.Preset
		w, h, kbps  int
	}{
		{"1080p120", "game120", protocol.PresetGame120, 1920, 1080, 14000},
		{"1440p120", "max120", protocol.PresetMax120, 2560, 1440, 20000},
	} {
		p, err := FindPreset(c.alias)
		if err != nil {
			t.Fatal(err)
		}
		if p.Name != c.name || p.Protocol != c.proto || p.Top.Width != c.w || p.Top.Height != c.h || p.Top.FPS != 120 || p.Top.Kbps != c.kbps {
			t.Fatalf("%s: %+v", c.alias, p)
		}
		layers, err := p.Layers(AllRIDs)
		if err != nil {
			t.Fatal(err)
		}
		if layers[0].FPS != 120 || layers[1].FPS != 60 || layers[1].Height != 720 || layers[2].FPS != 30 || layers[2].Height != 480 {
			t.Fatalf("%s layers %+v, want f@120, h=720p60, q=480p30", c.name, layers)
		}
	}
	for _, p := range Presets {
		if p.Top.FPS > MaxFPS {
			t.Errorf("%s runs at %d fps, above the %d fps ceiling", p.Name, p.Top.FPS, MaxFPS)
		}
	}
}

// H.264 Table A-1, with the 16-aligned sizes FitLayers makes.
func TestH264Level(t *testing.T) {
	for _, c := range []struct {
		w, h, fps, kbps int
		want            string
	}{
		{640, 480, 30, 1000, "3.0"},
		{880, 480, 30, 1000, "3.1"}, // PR #35: 880x480 → 3.1
		{1280, 720, 60, 3500, "3.2"},
		{1312, 720, 60, 3500, "4.0"}, // PR #35's ffprobe: 1312x720 → 4.0
		{1920, 1080, 60, 8000, "4.2"},
		{1904, 1040, 60, 8000, "4.2"},
		{2576, 1080, 60, 8000, "5.1"}, // PR #35: 2576x1080 → 5.1
		{2560, 1440, 60, 12000, "5.1"},
		{1920, 1080, 120, 14000, "5.1"}, // 4.2 stops at 1080p64
		{2560, 1440, 120, 20000, "5.2"}, // 5.1 stops at 1440p68
		{3440, 1440, 120, 20000, "6.0"}, // an ultrawide monitor at the 1440p120 preset
		{3840, 2160, 60, 25000, "5.2"},
		{1920, 1080, 30, 60000, "5.0"}, // the bitrate counts too
	} {
		if got := LevelName(H264Level(c.w, c.h, c.fps, c.kbps)); got != c.want {
			t.Errorf("%dx%d@%d %d kbit/s: level %s, want %s", c.w, c.h, c.fps, c.kbps, got, c.want)
		}
	}
	if got := H264Level(9000, 9000, 120, 1000); got != 0 {
		t.Errorf("an impossible size got level %d", got)
	}
}

func TestSDPLevel(t *testing.T) {
	for _, c := range []struct {
		preset string
		rids   []string
		want   int
	}{
		{"1080p60", []string{"q"}, MinSDPLevel}, // never below pion's 3.1
		{"1080p60", AllRIDs, 42},
		{"1440p60", AllRIDs, 51},
		{"1080p120", AllRIDs, 51},
		{"1440p120", AllRIDs, 52},
		{"1440p120", []string{"h", "q"}, 32},
	} {
		p, _ := FindPreset(c.preset)
		layers, _ := p.Layers(c.rids)
		if got := SDPLevel(layers); got != c.want {
			t.Errorf("%s %v: SDP level %d, want %d", c.preset, c.rids, got, c.want)
		}
	}
}

func TestSPSLevel(t *testing.T) {
	// AUD, then an SPS (profile 66, constraints 0xc0, level 52), then an IDR slice.
	au := []byte{0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 66, 0xc0, 52, 0xff, 0, 0, 1, 0x65, 0x88}
	if level, ok := SPSLevel(au); !ok || level != 52 {
		t.Fatalf("SPSLevel = %d, %v", level, ok)
	}
	if _, ok := SPSLevel([]byte{0, 0, 0, 1, 0x41, 0x9a}); ok {
		t.Fatal("a P slice has no SPS")
	}
}

// The GOP is time: twice the frames at 120 fps. VA-API caps key-int-max at 1024.
func TestEncoderSettingsPerFPS(t *testing.T) {
	l60 := Layer{RID: "f", Width: 1920, Height: 1080, FPS: 60, Kbps: 8000}
	l120 := Layer{RID: "f", Width: 1920, Height: 1080, FPS: 120, Kbps: 14000}
	gop := 10 * time.Second
	for _, c := range []struct {
		enc       Encoder
		l         Layer
		gopFrames int
		vbvKbit   int
	}{
		{EncoderNVENC, l60, 600, 2000},
		{EncoderNVENC, l120, 1200, 3500},
		{EncoderX264, l120, 1200, 3500},
		{EncoderVA, l60, 600, 2000},
		{EncoderVA, l120, vaMaxGOP, 3500},
		{EncoderVALowPower, l120, vaMaxGOP, 3500},
	} {
		s := settingsFor(c.enc, c.l, gop)
		if s.gopFrames != c.gopFrames || s.vbvKbit != c.vbvKbit || s.vbvMillis != int(DefaultVBV.Milliseconds()) {
			t.Errorf("%s at %d fps: %+v, want GOP %d frames and VBV %d kbit", c.enc, c.l.FPS, s, c.gopFrames, c.vbvKbit)
		}
	}
	for enc, want := range map[Encoder]string{
		EncoderNVENC: "gop-size=1200",
		EncoderVA:    "key-int-max=1024",
		EncoderX264:  "key-int-max=1200",
	} {
		desc, err := encoderElement(enc, l120, gop)
		if err != nil || !strings.Contains(desc, want) {
			t.Errorf("%s: %q (%v), want %s", enc, desc, err, want)
		}
	}
}

// A 120 fps preset on a 60 Hz monitor captures 60 fps; the 60 fps layers stay as they are.
func TestCapFPS(t *testing.T) {
	layers := presetLayers(t, "1440p120")
	got, changed := CapFPS(layers, 59.94)
	if !changed || got[0].FPS != 60 || got[1].FPS != 60 || got[2].FPS != 30 {
		t.Fatalf("at 59.94 Hz: %v %+v", changed, got)
	}
	if layers[0].FPS != 120 {
		t.Fatal("CapFPS changed its input")
	}
	got, changed = CapFPS(layers, 100)
	if !changed || got[0].FPS != 100 {
		t.Fatalf("at 100 Hz: %v %+v", changed, got)
	}
	for _, hz := range []float64{0, 120, 174.96} {
		if got, changed := CapFPS(layers, hz); changed || got[0].FPS != 120 {
			t.Fatalf("at %v Hz: %v %+v", hz, changed, got)
		}
	}
}

// The whole encoder pipeline of a 120 fps preset: the mixer and f at 120, h and q dropped
// to 60 and 30 with videorate.
func TestLinuxPipelineDescription120(t *testing.T) {
	layers := presetLayers(t, "1440p120")
	desc, err := linuxPipelineDescription(PathGL, layers, EncoderNVENC, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"width=2560,height=1440,framerate=120/1",
		"name=enc_f preset=p1 tune=ultra-low-latency rc-mode=cbr bitrate=20000 vbv-buffer-size=5000 gop-size=1200",
		"videorate drop-only=true ! video/x-raw(memory:GLMemory),framerate=60/1",
		"videorate drop-only=true ! video/x-raw(memory:GLMemory),framerate=30/1",
	} {
		if !strings.Contains(desc, want) {
			t.Errorf("pipeline lacks %q:\n%s", want, desc)
		}
	}
	src := linuxSourceDescription(PathGL, sourceSpec{serial: 7, fps: layers[0].FPS})
	if !strings.Contains(src, "max-framerate=120/1") {
		t.Errorf("capture not at 120: %s", src)
	}
}
