// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"slices"
	"strings"
	"testing"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// fakeTimers drives Keyframes with a manual clock.
type fakeTimers struct {
	now     time.Time
	pending []timer
}

type timer struct {
	at time.Time
	f  func()
}

func (c *fakeTimers) afterFunc(d time.Duration, f func()) {
	c.pending = append(c.pending, timer{at: c.now.Add(d), f: f})
}

func (c *fakeTimers) advance(d time.Duration) {
	c.now = c.now.Add(d)
	var keep []timer
	var due []timer
	for _, t := range c.pending {
		if !t.at.After(c.now) {
			due = append(due, t)
		} else {
			keep = append(keep, t)
		}
	}
	c.pending = keep
	for _, t := range due {
		t.f()
	}
}

func TestKeyframesRateLimitAndCoalesce(t *testing.T) {
	clock := &fakeTimers{now: time.Unix(1000, 0)}
	forced := 0
	k := NewKeyframes(300*time.Millisecond, func() { forced++ })
	k.now = func() time.Time { return clock.now }
	k.afterFunc = clock.afterFunc

	k.Request() // first request: IDR at once
	if forced != 1 {
		t.Fatalf("first request: forced %d, want 1", forced)
	}
	clock.advance(50 * time.Millisecond)
	k.Request() // inside the window: deferred
	k.Request() // joins the deferred one
	k.Request()
	if forced != 1 {
		t.Fatalf("inside the window: forced %d, want still 1", forced)
	}
	if len(clock.pending) != 1 {
		t.Fatalf("scheduled %d deferred IDRs, want 1", len(clock.pending))
	}
	clock.advance(249 * time.Millisecond)
	if forced != 1 {
		t.Fatalf("before the window ends: forced %d, want 1", forced)
	}
	clock.advance(time.Millisecond) // window ends at 300 ms
	if forced != 2 {
		t.Fatalf("end of window: forced %d, want 2", forced)
	}
	// The deferred IDR opened a new window.
	clock.advance(100 * time.Millisecond)
	k.Request()
	if forced != 2 || len(clock.pending) != 1 {
		t.Fatalf("after the deferred IDR: forced %d pending %d, want 2 and 1", forced, len(clock.pending))
	}
	clock.advance(200 * time.Millisecond)
	if forced != 3 {
		t.Fatalf("second deferred IDR: forced %d, want 3", forced)
	}
	// Outside every window: immediate again.
	clock.advance(time.Second)
	k.Request()
	if forced != 4 {
		t.Fatalf("outside the window: forced %d, want 4", forced)
	}
	got := k.Stats()
	want := KeyframeStats{Requests: 6, Forced: 4, Coalesced: 4}
	if got != want {
		t.Fatalf("stats %+v, want %+v", got, want)
	}
}

func TestPresets(t *testing.T) {
	p, err := FindPreset("GAME")
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "1080p60" || p.Protocol != protocol.PresetGame {
		t.Fatalf("alias game resolved to %+v", p)
	}
	if _, err := FindPreset("4k"); err == nil {
		t.Fatal("unknown preset accepted")
	}
	for _, p := range Presets {
		if !slices.Contains(protocol.PresetValues, p.Protocol) {
			t.Errorf("preset %s: protocol preset %q is not in the schema", p.Name, p.Protocol)
		}
	}

	text, _ := FindPreset("1080p30")
	layers, err := text.Layers(ParseLayers("q, f ,f"))
	if err != nil {
		t.Fatal(err)
	}
	if len(layers) != 2 || layers[0].RID != "f" || layers[1].RID != "q" {
		t.Fatalf("layers %+v, want f then q", layers)
	}
	all, _ := text.Layers(AllRIDs)
	if all[1].FPS != 30 {
		t.Fatalf("h layer of a 30 fps preset runs at %d fps", all[1].FPS)
	}
	if _, err := text.Layers([]string{"x"}); err == nil {
		t.Fatal("unknown layer accepted")
	}
	if _, err := text.Layers(nil); err == nil {
		t.Fatal("no layers accepted")
	}
}

func TestResolveEncoder(t *testing.T) {
	only := func(names ...string) func(string) bool {
		return func(n string) bool {
			for _, x := range names {
				if x == n {
					return true
				}
			}
			return false
		}
	}
	cases := []struct {
		in   Encoder
		has  func(string) bool
		want Encoder
		err  bool
	}{
		{EncoderAuto, only("nvh264enc", "x264enc"), EncoderNVENC, false},
		{EncoderAuto, only("x264enc"), EncoderX264, false},
		{EncoderAuto, only(), "", true},
		{EncoderNVENC, only("x264enc"), "", true},
		{EncoderX264, only("x264enc"), EncoderX264, false},
		// NVENC → VA-API → x264.
		{EncoderAuto, only("vah264enc", "x264enc"), EncoderVA, false},
		{EncoderAuto, only("nvh264enc", "vah264enc", "x264enc"), EncoderNVENC, false},
		{EncoderAuto, only("vah264lpenc", "x264enc"), EncoderVALowPower, false},
		{EncoderVA, only("vah264enc", "vah264lpenc"), EncoderVA, false},
		{EncoderVA, only("vah264lpenc"), EncoderVALowPower, false},
		{EncoderVA, only("x264enc"), "", true},
		{EncoderVALowPower, only("vah264enc"), "", true},
	}
	for _, c := range cases {
		got, err := ResolveEncoder(c.in, c.has)
		if (err != nil) != c.err || got != c.want {
			t.Errorf("ResolveEncoder(%s) = %q, %v; want %q, error %v", c.in, got, err, c.want, c.err)
		}
	}
	if _, err := ParseEncoder("vaapi"); err == nil {
		t.Error("unknown encoder accepted")
	}
	for _, e := range []string{"auto", "nvh264", "va", "va-lp", "x264"} {
		if _, err := ParseEncoder(e); err != nil {
			t.Errorf("ParseEncoder(%s): %v", e, err)
		}
	}
	if got := DetectEncoders(only("vah264enc", "x264enc")); len(got) != 2 || got[0] != EncoderVA || got[1] != EncoderX264 {
		t.Errorf("DetectEncoders = %v", got)
	}
	if EncoderX264.Hardware() || !EncoderVALowPower.Hardware() || !EncoderVALowPower.IsVA() || EncoderNVENC.IsVA() {
		t.Error("Hardware/IsVA")
	}
}

func TestVAEncoderElement(t *testing.T) {
	l := Layer{RID: "h", Width: 1280, Height: 720, FPS: 60, Kbps: 3500}
	for e, el := range map[Encoder]string{EncoderVA: "vah264enc", EncoderVALowPower: "vah264lpenc"} {
		desc, err := encoderElement(e, l, 10*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		// CBR, fixed CPB of 250 ms at the start bitrate (kbit), 10 s GOP, no B-frames, and
		// no CABAC/8x8 so the profile is the constrained baseline pion signals.
		want := el + " name=enc_h rate-control=cbr bitrate=3500 cpb-size=875 key-int-max=600 b-frames=0 ref-frames=1 " +
			"cabac=false dct8x8=false aud=true target-usage=7 ! video/x-h264,profile=constrained-baseline"
		if desc != want {
			t.Errorf("%s:\n got %s\nwant %s", e, desc, want)
		}
	}
}

func TestTestPipelineDescription(t *testing.T) {
	p, _ := FindPreset("1080p60")
	layers, _ := p.Layers(AllRIDs)
	desc, err := testPipelineDescription(layers, EncoderNVENC, 10*time.Second, true, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"width=1920,height=1080,framerate=60/1",
		"timeoverlay time-mode=buffer-count",
		"textoverlay name=" + clockOverlayName,
		// Long GOP (10 s at 60 and 30 fps), fixed VBV of 250 ms at the start bitrate, no B-frames.
		"nvh264enc name=enc_f preset=p1 tune=ultra-low-latency rc-mode=cbr bitrate=8000 vbv-buffer-size=2000 gop-size=600 bframes=0",
		"nvh264enc name=enc_q preset=p1 tune=ultra-low-latency rc-mode=cbr bitrate=1000 vbv-buffer-size=250 gop-size=300",
		"appsink name=sink_f", "appsink name=sink_h", "appsink name=sink_q",
		"audiotestsrc name=tone is-live=true wave=sine freq=440",
		"opusenc bitrate=128000",
		"framerate=1/2 ! videoscale ! videoconvert ! video/x-raw,format=I420,width=320,height=180 ! jpegenc quality=70 ! appsink name=thumbsink",
	} {
		if !strings.Contains(desc, want) {
			t.Errorf("pipeline lacks %q:\n%s", want, desc)
		}
	}
	noAudio, _ := testPipelineDescription(layers[:1], EncoderX264, 4*time.Second, false, "")
	if strings.Contains(noAudio, "audiotestsrc") || strings.Contains(noAudio, "sink_h") {
		t.Errorf("pipeline without audio and with one layer:\n%s", noAudio)
	}
	if !strings.Contains(noAudio, "x264enc name=enc_f tune=zerolatency speed-preset=ultrafast sliced-threads=true bitrate=8000 vbv-buf-capacity=250 key-int-max=240 bframes=0") {
		t.Errorf("x264 settings:\n%s", noAudio)
	}
	still, _ := testPipelineDescription(layers, EncoderX264, 4*time.Second, false, `/tmp/a "b".png`)
	for _, want := range []string{
		`filesrc location="/tmp/a \"b\".png" ! decodebin`,
		"width=1920,height=1080,pixel-aspect-ratio=1/1 ! imagefreeze is-live=true ! video/x-raw,framerate=60/1 ! tee name=t",
		"appsink name=sink_q",
	} {
		if !strings.Contains(still, want) {
			t.Errorf("image pipeline lacks %q:\n%s", want, still)
		}
	}
	if strings.Contains(still, "videotestsrc") || strings.Contains(still, "textoverlay") || strings.Contains(still, "timeoverlay") {
		t.Errorf("image pipeline draws over the image:\n%s", still)
	}
}
