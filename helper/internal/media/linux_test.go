// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/portal"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

func presetLayers(t *testing.T, name string) []Layer {
	t.Helper()
	p, err := FindPreset(name)
	if err != nil {
		t.Fatal(err)
	}
	layers, err := p.Layers(AllRIDs)
	if err != nil {
		t.Fatal(err)
	}
	return layers
}

func TestFitLayers(t *testing.T) {
	layers := presetLayers(t, "1080p60")
	size := func(ls []Layer) []string {
		var out []string
		for _, l := range ls {
			out = append(out, l.RID+"="+strconv.Itoa(l.Width)+"x"+strconv.Itoa(l.Height))
		}
		return out
	}
	cases := []struct {
		name     string
		srcW     int
		srcH     int
		want     string
		original bool
	}{
		// Measured: the 3440x1440 monitor at the 1080p preset was 2580x1080; widths are
		// now multiples of 16 (the mixer letterboxes the 4 pixels).
		{"ultrawide", 3440, 1440, "f=2576x1080 h=1728x720 q=1152x480", false},
		{"16:9", 2560, 1440, "f=1920x1080 h=1280x720 q=848x480", false},
		{"small window, no upscale", 800, 600, "f=784x592 h=784x592 q=640x480", false},
		{"odd sizes are aligned", 1001, 701, "f=976x688 h=976x688 q=688x480", false},
		// A window a little smaller than the screen, as Henrique's on KDE.
		{"window", 1913, 1047, "f=1904x1040 h=1312x720 q=880x480", false},
		{"portrait window", 900, 1600, "f=608x1080 h=400x720 q=272x480", false},
		{"wider than NVENC: the width cap sets the height", 7680, 1080, "f=4096x576 h=4096x576 q=3408x480", false},
		{"unknown size", 0, 0, "", true},
	}
	for _, c := range cases {
		got := FitLayers(layers, c.srcW, c.srcH)
		if c.original {
			if got[0] != layers[0] {
				t.Errorf("%s: changed %+v", c.name, got[0])
			}
			continue
		}
		if s := strings.Join(size(got), " "); s != c.want {
			t.Errorf("%s: %s, want %s", c.name, s, c.want)
		}
		for i := range got {
			if got[i].FPS != layers[i].FPS || got[i].Kbps != layers[i].Kbps {
				t.Errorf("%s: rate or bitrate changed on %s", c.name, got[i].RID)
			}
		}
	}
	if layers[0].Width != 1920 {
		t.Error("FitLayers changed its input")
	}
}

// Every layer of every source size is 16-aligned in width, even in height, never larger than
// the source, and within NVENC's width: the sizes WebKit's and Chrome's decoders get.
func TestFitLayersAlignment(t *testing.T) {
	for _, name := range []string{"1080p30", "1080p60", "1440p60", "2160p60", "1080p120", "1440p120"} {
		layers := presetLayers(t, name)
		for srcW := 17; srcW <= 7700; srcW += 37 {
			for srcH := 17; srcH <= 4400; srcH += 41 {
				for _, l := range FitLayers(layers, srcW, srcH) {
					if l.Width%16 != 0 || l.Height%2 != 0 || l.Width > max(16, srcW) || l.Height > max(16, srcH) ||
						l.Width > maxH264Width || l.Width < 16 || l.Height < 2 {
						t.Fatalf("%s %dx%d: layer %s is %dx%d", name, srcW, srcH, l.RID, l.Width, l.Height)
					}
				}
			}
		}
	}
}

func TestFitRect(t *testing.T) {
	cases := []struct {
		srcW, srcH, outW, outH int
		want                   Rect
	}{
		{1920, 1080, 1920, 1080, Rect{0, 0, 1920, 1080}},
		// A window that became narrower: pillarbox.
		{1280, 1024, 1920, 1080, Rect{X: 285, Y: 0, W: 1350, H: 1080}},
		// Wider: letterbox.
		{2400, 600, 1920, 1080, Rect{X: 0, Y: 300, W: 1920, H: 480}},
		{0, 0, 1920, 1080, Rect{0, 0, 1920, 1080}},
	}
	for _, c := range cases {
		if got := FitRect(c.srcW, c.srcH, c.outW, c.outH); got != c.want {
			t.Errorf("FitRect(%d,%d → %d,%d) = %+v, want %+v", c.srcW, c.srcH, c.outW, c.outH, got, c.want)
		}
	}
}

func TestSourcePolicyResize(t *testing.T) {
	t0 := time.Unix(1000, 0)
	p := newSourcePolicy(t0)
	if r := p.onCaps(1600, 900); r != restartNone {
		t.Fatalf("first caps restarted: %q", r)
	}
	if r := p.onCaps(1600, 900); r != restartNone {
		t.Fatalf("same caps restarted: %q", r)
	}
	// Measured: the new size negotiates and then pipewiresrc stalls; restart.
	if r := p.onCaps(1280, 720); r != restartResize {
		t.Fatalf("resize: %q", r)
	}
	if !p.allow(t0, restartResize) {
		t.Fatal("first restart refused")
	}
	// The new branch's first caps are its size, not a resize.
	if r := p.onCaps(1280, 720); r != restartNone {
		t.Fatalf("new branch's caps restarted: %q", r)
	}
	if w, h := p.size(); w != 1280 || h != 720 {
		t.Fatalf("size %dx%d", w, h)
	}
}

func TestSourcePolicyRateLimit(t *testing.T) {
	t0 := time.Unix(1000, 0)
	p := newSourcePolicy(t0)
	n := 0
	for i := range 10 {
		if p.allow(t0.Add(time.Duration(i)*time.Second), restartResize) {
			n++
		}
	}
	if n != p.burst {
		t.Fatalf("%d restarts in 10 s, want %d", n, p.burst)
	}
	if !p.allow(t0.Add(p.burstWindow+10*time.Second), restartResize) {
		t.Fatal("restart refused after the window")
	}
}

func TestSourcePolicyWatchdog(t *testing.T) {
	t0 := time.Unix(1000, 0)
	p := newSourcePolicy(t0)
	if r, err := p.check(t0.Add(9 * time.Second)); r != restartNone || err != nil {
		t.Fatalf("before the timeout: %q %v", r, err)
	}
	// A source that never delivers: one restart, then fatal.
	r, err := p.check(t0.Add(10 * time.Second))
	if r != restartTimeout || err != nil {
		t.Fatalf("at the timeout: %q %v", r, err)
	}
	p.allow(t0.Add(10*time.Second), r)
	if r, err := p.check(t0.Add(15 * time.Second)); r != restartNone || err != nil {
		t.Fatalf("restarted branch still in its grace: %q %v", r, err)
	}
	if _, err := p.check(t0.Add(20 * time.Second)); !errors.Is(err, ErrSourceStalled) {
		t.Fatalf("no frame after the restart: %v", err)
	}

	// A source that delivered and then stopped also gets one restart; frames reset it.
	p = newSourcePolicy(t0)
	p.onFrame(t0.Add(time.Second))
	if r, _ := p.check(t0.Add(11 * time.Second)); r != restartTimeout {
		t.Fatalf("stopped source: %q", r)
	}
	p.allow(t0.Add(11*time.Second), restartTimeout)
	p.onFrame(t0.Add(12 * time.Second))
	if r, err := p.check(t0.Add(13 * time.Second)); r != restartNone || err != nil {
		t.Fatalf("recovered source: %q %v", r, err)
	}
}

func TestPauseState(t *testing.T) {
	cases := []struct {
		s      pauseState
		paused bool
		reason protocol.PauseReason
	}{
		{pauseState{}, false, ""},
		{pauseState{minimized: true}, true, protocol.PauseReasonSourceHidden},
		{pauseState{still: true}, true, protocol.PauseReasonSourceHidden},
		{pauseState{curtain: true, minimized: true}, true, protocol.PauseReasonPrivacyCurtain},
	}
	for _, c := range cases {
		if p, r := c.s.paused(); p != c.paused || r != c.reason {
			t.Errorf("%+v: %v %q, want %v %q", c.s, p, r, c.paused, c.reason)
		}
	}
}

func TestStillDetector(t *testing.T) {
	top := Layer{RID: "f", FPS: 60, Kbps: 8000}
	if newStillDetector(0, top, time.Now()) != nil {
		t.Fatal("still detection is on by default")
	}
	t0 := time.Unix(1000, 0)
	d := newStillDetector(5*time.Second, top, t0)
	if d.maxBytes != 520 {
		t.Fatalf("threshold %d", d.maxBytes)
	}
	frame := func(sec float64, size int, key bool) bool {
		return d.frame(t0.Add(time.Duration(sec*float64(time.Second))), size, key)
	}
	if frame(1, 16000, false) {
		t.Fatal("moving content is still")
	}
	// Static content: tiny frames. A keyframe (forced by a viewer's PLI) is big but
	// does not count as a change.
	frame(2, 200, false)
	frame(4, 30000, true)
	if frame(5.9, 200, false) {
		t.Fatal("still before 5 s")
	}
	if !frame(6.1, 200, false) {
		t.Fatal("not still after 5 s of tiny frames")
	}
	if frame(6.2, 9000, false) {
		t.Fatal("still after a change")
	}
}

func TestLinuxPipelineDescription(t *testing.T) {
	layers := FitLayers(presetLayers(t, "1080p60"), 3440, 1440)
	gl, err := linuxPipelineDescription(PathGL, layers, EncoderNVENC, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"glvideomixer name=mix background=black",
		// The always-live black input keeps the encoders fed when the capture stalls.
		"gltestsrc is-live=true pattern=black",
		"proxysrc name=capsrc ! queue name=capq max-size-buffers=1 max-size-bytes=0 max-size-time=100000000 leaky=downstream ! glupload ! glcolorconvert",
		"video/x-raw(memory:GLMemory),format=RGBA,width=2576,height=1080,framerate=60/1",
		"glcolorscale ! video/x-raw(memory:GLMemory),width=1728,height=720",
		"framerate=30/1 ! cudaupload",
		"nvh264enc name=enc_f", "appsink name=sink_q",
	} {
		if !strings.Contains(gl, want) {
			t.Errorf("GL description lacks %q:\n%s", want, gl)
		}
	}
	// The top layer is not scaled again; the third is the thumbnail's.
	if strings.Count(gl, "glcolorscale ") != 3 {
		t.Errorf("want 3 glcolorscale (h, q, thumbnail):\n%s", gl)
	}
	// The thumbnail branch: leaky, rate-limited in GL, never blocking (drop), 320 px wide.
	for _, want := range []string{
		"t. ! queue max-size-buffers=1 leaky=downstream ! videorate drop-only=true ! video/x-raw(memory:GLMemory),framerate=1/2",
		"width=320,height=134 ! glcolorconvert ! video/x-raw(memory:GLMemory),format=I420 ! gldownload ! jpegenc quality=70",
		"appsink name=thumbsink emit-signals=false sync=false max-buffers=1 drop=true",
	} {
		if !strings.Contains(gl, want) {
			t.Errorf("GL description lacks %q:\n%s", want, gl)
		}
	}
	x264, err := linuxPipelineDescription(PathGL, layers, EncoderX264, 10*time.Second)
	if err != nil || !strings.Contains(x264, "gldownload ! videoconvert ! video/x-raw,format=I420") || strings.Contains(x264, "cudaupload") {
		t.Errorf("x264 on GL: %v\n%s", err, x264)
	}
	va, err := linuxPipelineDescription(PathGL, layers, EncoderVA, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// Scale and drop frames in GL, then GL texture → DMA-BUF → VA surface (no CPU copy).
	for _, want := range []string{
		"glcolorscale ! video/x-raw(memory:GLMemory),width=1152,height=480 ! videorate drop-only=true ! video/x-raw(memory:GLMemory),framerate=30/1 ! gldownload ! vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! vah264enc name=enc_q",
		"vah264enc name=enc_f",
	} {
		if !strings.Contains(va, want) {
			t.Errorf("VA description lacks %q:\n%s", want, va)
		}
	}
	if strings.Contains(va, "cudaupload") || strings.Contains(va, "videoconvert") {
		t.Errorf("VA on GL converts on the CPU or uploads to CUDA:\n%s", va)
	}
	vaCPU, err := linuxPipelineDescription(PathCPU, layers, EncoderVALowPower, 10*time.Second)
	if err != nil || !strings.Contains(vaCPU, "videoconvert ! video/x-raw,format=NV12 ! vah264lpenc name=enc_f") {
		t.Errorf("VA on the CPU path: %v\n%s", err, vaCPU)
	}
	cpu, err := linuxPipelineDescription(PathCPU, layers, EncoderX264, 10*time.Second)
	if err != nil || !strings.Contains(cpu, "compositor name=mix") || strings.Contains(cpu, "gl") {
		t.Errorf("CPU path: %v\n%s", err, cpu)
	}
	if !strings.Contains(cpu, "videoscale ! videoconvert ! video/x-raw,format=I420,width=320,height=134 ! jpegenc") {
		t.Errorf("CPU thumbnail branch:\n%s", cpu)
	}
}

func TestLinuxSourceDescription(t *testing.T) {
	window := linuxSourceDescription(PathGL, sourceSpec{fd: 7, serial: 5123, fps: 60})
	for _, want := range []string{
		"pipewiresrc name=vsrc fd=7 target-object=5123",
		// Measured: without max-framerate KWin delivers up to the monitor's refresh.
		"video/x-raw(memory:DMABuf),max-framerate=60/1 !",
		"! proxysink name=capsink",
	} {
		if !strings.Contains(window, want) {
			t.Errorf("lacks %q:\n%s", want, window)
		}
	}
	// The size is never pinned and no GL runs here: the encoder pipeline uploads, and a
	// window's size changes.
	if strings.Contains(window, "width=") || strings.Contains(window, "gl") {
		t.Errorf("size pinned:\n%s", window)
	}
	shm := linuxSourceDescription(PathGL, sourceSpec{fd: 7, serial: 1, fps: 30, shm: true})
	if !strings.Contains(shm, "video/x-raw,format=BGRx,max-framerate=30/1") {
		t.Errorf("shm:\n%s", shm)
	}
	test := linuxSourceDescription(PathGL, sourceSpec{testPattern: "ball", width: 1600, height: 900, fps: 60})
	if !strings.HasPrefix(test, "videotestsrc name=vsrc") || strings.Contains(test, "pipewiresrc") {
		t.Errorf("test pattern:\n%s", test)
	}
	// No GStreamer PipeWire audio element anywhere.
	for _, d := range []string{window, shm, test} {
		if strings.Contains(d, "pipewiresink") || strings.Contains(d, "audio") {
			t.Errorf("audio element in a capture branch:\n%s", d)
		}
	}
}

func TestResolveCapturePath(t *testing.T) {
	all := func(string) bool { return true }
	noGL := func(e string) bool { return !strings.HasPrefix(e, "gl") }
	noCUDA := func(e string) bool { return e != "cudaupload" }
	if p := ResolveCapturePath(PathAuto, EncoderNVENC, all); p != PathGL {
		t.Errorf("all elements: %s", p)
	}
	if p := ResolveCapturePath(PathAuto, EncoderNVENC, noGL); p != PathCPU {
		t.Errorf("no GL: %s", p)
	}
	if p := ResolveCapturePath(PathAuto, EncoderNVENC, noCUDA); p != PathCPU {
		t.Errorf("no cudaupload: %s", p)
	}
	if p := ResolveCapturePath(PathAuto, EncoderX264, noCUDA); p != PathGL {
		t.Errorf("x264 without CUDA: %s", p)
	}
	if p := ResolveCapturePath(PathAuto, EncoderVA, all); p != PathGL {
		t.Errorf("VA with vapostproc: %s", p)
	}
	if p := ResolveCapturePath(PathAuto, EncoderVA, func(e string) bool { return e != "vapostproc" }); p != PathCPU {
		t.Errorf("VA without vapostproc: %s", p)
	}
	if p := ResolveCapturePath(PathCPU, EncoderNVENC, all); p != PathCPU {
		t.Errorf("explicit cpu: %s", p)
	}
}

func TestIsSourceEndedMessage(t *testing.T) {
	if !isSourceEndedMessage("gstreamer: stream error: target not found (../src/gst/gstpipewiresrc.c)") {
		t.Error("closed window not recognised")
	}
	if isSourceEndedMessage("gstreamer: Internal data stream error") {
		t.Error("generic error taken as source end")
	}
}

func TestPortalSources(t *testing.T) {
	store := portal.Store{Path: t.TempDir() + "/screencast.json"}
	ids := func(ss []Source) string {
		var out []string
		for _, s := range ss {
			out = append(out, s.ID)
		}
		return strings.Join(out, " ")
	}
	if got := ids(PortalSources(store)); got != "portal:screen portal:window" {
		t.Fatalf("no saved choice: %s", got)
	}
	// A token saved before the choice was known (the source then failed to start) is not
	// listed: there is nothing to show as "Last".
	if err := store.SaveToken(portal.KindMonitor, "tok-0", time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := ids(PortalSources(store)); got != "portal:screen portal:window" {
		t.Fatalf("token without a choice: %s", got)
	}
	save := func(kind portal.Kind, token string, c portal.Choice) {
		t.Helper()
		if err := store.Save(kind, portal.Record{Token: token, Choice: c, SavedAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	save(portal.KindMonitor, "tok-1", portal.Choice{Kind: portal.KindMonitor, Output: "DP-2", Width: 3440, Height: 1440})
	save(portal.KindWindow, "tok-2", portal.Choice{Kind: portal.KindWindow, WindowClass: "firefox", WindowCaption: "Docs — Firefox", Width: 1913, Height: 1047})
	got := PortalSources(store)
	if ids(got) != "portal:screen portal:window portal:screen:last portal:window:last" {
		t.Fatalf("sources = %s", ids(got))
	}
	for _, s := range got[:2] {
		if s.Restored || !s.IsPortalPicker() || s.IsPortalLast() {
			t.Errorf("picker %+v", s)
		}
	}
	if s := got[2]; !s.Restored || s.Kind != SourceScreen || s.Label != "DP-2" || s.Width != 3440 || s.HasAudio || !s.IsPortalLast() {
		t.Errorf("last screen = %+v", s)
	}
	if s := got[3]; !s.Restored || s.Kind != SourceWindow || s.Label != "Docs — Firefox" || s.AppName != "firefox" || !s.HasAudio {
		t.Errorf("last window = %+v", s)
	}
	// After the portal refused the token (Forget), the window is no longer restorable.
	if err := store.Forget(portal.KindWindow); err != nil {
		t.Fatal(err)
	}
	if got := ids(PortalSources(store)); got != "portal:screen portal:window portal:screen:last" {
		t.Fatalf("after Forget: %s", got)
	}
}

func TestRestores(t *testing.T) {
	cases := []struct {
		src  Source
		pick bool
		want bool
	}{
		// "Choose a screen/window…" always shows the dialog (the bug: the saved token
		// restored the last window silently, so the picker never came back).
		{Source{ID: PortalScreenID, Kind: SourceScreen}, false, false},
		{Source{ID: PortalWindowID, Kind: SourceWindow}, false, false},
		{Source{ID: PortalLastWindowID, Kind: SourceWindow, Restored: true}, false, true},
		{Source{ID: PortalLastScreenID, Kind: SourceScreen, Restored: true}, true, false},
		// The CLI's own sources restore unless --pick.
		{Source{ID: "window", Kind: SourceWindow}, false, true},
		{Source{ID: "monitor", Kind: SourceScreen}, true, false},
	}
	for _, c := range cases {
		if got := restores(c.src, c.pick); got != c.want {
			t.Errorf("restores(%s, pick=%v) = %v, want %v", c.src.ID, c.pick, got, c.want)
		}
	}
}

func TestMonitorPixelSize(t *testing.T) {
	cases := []struct {
		pw, ph, lw, lh int
		scale          float64
		w, h           int
	}{
		// KDE scale 2: the portal says 1920x1080, the output has 3840x2160 pixels.
		{1920, 1080, 1920, 1080, 2, 3840, 2160},
		// Fractional: 3840x2160 at 1.25 is 3072x1728 logical.
		{3072, 1728, 3072, 1728, 1.25, 3840, 2160},
		// Unscaled.
		{3440, 1440, 3440, 1440, 1, 3440, 1440},
		// The portal already reports pixels.
		{3840, 2160, 1920, 1080, 2, 3840, 2160},
		// Unknown scale.
		{1920, 1080, 1920, 1080, 0, 1920, 1080},
	}
	for _, c := range cases {
		if w, h := MonitorPixelSize(c.pw, c.ph, c.lw, c.lh, c.scale); w != c.w || h != c.h {
			t.Errorf("MonitorPixelSize(%dx%d, %dx%d @%g) = %dx%d, want %dx%d", c.pw, c.ph, c.lw, c.lh, c.scale, w, h, c.w, c.h)
		}
	}
	// What this changes for the layers: 2160p60 on a scale-2 4K output keeps 2160 lines
	// instead of being capped at the logical 1080.
	native, _ := FindPreset("2160p60")
	layers, _ := native.Layers(AllRIDs)
	w, h := MonitorPixelSize(1920, 1080, 1920, 1080, 2)
	if top := FitLayers(layers, w, h)[0]; top.Width != 3840 || top.Height != 2160 {
		t.Errorf("top layer %dx%d, want 3840x2160", top.Width, top.Height)
	}
	// Before: the logical size capped it (1904x1072 after the 16-alignment).
	if top := FitLayers(layers, 1920, 1080)[0]; top.Height > 1080 {
		t.Errorf("logical size: top layer %dx%d, want at most 1080 lines", top.Width, top.Height)
	}
}

// TestPauseStateAudioMuted: only the privacy curtain silences the stream's audio; a
// hidden or still source keeps its sound.
func TestPauseStateAudioMuted(t *testing.T) {
	for _, c := range []struct {
		s    pauseState
		want bool
	}{
		{pauseState{}, false},
		{pauseState{minimized: true}, false},
		{pauseState{still: true}, false},
		{pauseState{curtain: true}, true},
		{pauseState{curtain: true, minimized: true}, true},
	} {
		if got := c.s.audioMuted(); got != c.want {
			t.Errorf("%+v: audioMuted %v, want %v", c.s, got, c.want)
		}
	}
}

func TestAudioPipelineDescription(t *testing.T) {
	d := audioPipelineDescription(7, 48000, 2, "audiosink")
	for _, want := range []string{
		"fdsrc name=asrc fd=7",
		"volume name=" + audioMuteName + " mute=false ! amix.",
		// The live silence input keeps the Opus track flowing under the curtain.
		"audiotestsrc wave=silence is-live=true",
		"audiomixer name=amix ! opusenc bitrate=128000 frame-size=20",
		"appsink name=audiosink",
	} {
		if !strings.Contains(d, want) {
			t.Errorf("audio description lacks %q:\n%s", want, d)
		}
	}
}
