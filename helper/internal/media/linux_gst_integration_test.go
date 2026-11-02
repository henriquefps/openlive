// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux && !nogst && integration

package media

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// TestLinuxPipeline runs the Linux backend's pipelines on a test pattern instead of the
// portal: go test -tags integration -run LinuxPipeline ./internal/media/
// It needs a GPU with GL (and NVENC for the default encoder).
func TestLinuxPipeline(t *testing.T) {
	if !HasElement("glvideomixer") || !HasElement("nvh264enc") {
		t.Skip("no GL mixer or NVENC")
	}
	preset, _ := FindPreset("1080p60")
	layers, _ := preset.Layers(AllRIDs)
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	b, _ := NewLinuxBackend(LinuxOptions{TestPattern: "ball", TestWidth: 2560, TestHeight: 1080, Log: log})
	t0 := time.Now()
	st, err := b.Start(context.Background(), Source{Kind: SourceTest}, Profile{Layers: layers, Encoder: EncoderNVENC, GOP: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	// The encoder pipeline reaches PLAYING only with the first capture frame; waiting for
	// PLAYING before adding the capture cost a 5 s timeout on every start.
	if d := time.Since(t0); d > 2*time.Second {
		t.Errorf("Start took %s, want under 2 s", d)
	}
	s := st.(*LinuxStream)
	defer func() { _ = s.Stop() }()
	for _, l := range s.Layers() {
		t.Logf("layer %s %dx%d@%d", l.RID, l.Width, l.Height, l.FPS)
	}
	if got := s.Layers()[0]; got.Width != 2560 || got.Height != 1080 {
		t.Fatalf("top layer %dx%d, want 2560x1080", got.Width, got.Height)
	}

	count := func(d time.Duration) map[string]int {
		n := map[string]int{}
		end := time.After(d)
		for {
			select {
			case f := <-s.Video():
				n[f.RID]++
			case err := <-s.Err():
				t.Fatalf("stream error: %v", err)
			case <-end:
				return n
			}
		}
	}
	checkFPS := func(phase string, n map[string]int, secs float64) {
		for _, l := range s.Layers() {
			fps := float64(n[l.RID]) / secs
			t.Logf("%s: layer %s %.1f fps", phase, l.RID, fps)
			if fps < float64(l.FPS)*0.9 {
				t.Errorf("%s: layer %s at %.1f fps, want ~%d", phase, l.RID, fps, l.FPS)
			}
		}
	}
	// No backlog: the first second already runs at the layers' rates (the mixer used to
	// catch up the 5 s spent waiting, ~300 frames at once).
	checkFPS("first second", count(time.Second), 1)
	checkFPS("start", count(3*time.Second), 3)
	if r := s.CaptureStats().Restarts; r != 0 {
		t.Errorf("%d capture restarts at start, want 0", r)
	}

	// A source resize: the branch restarts at the new size, the output size stays.
	s.specReq <- func(sp *sourceSpec) { sp.width, sp.height = 1600, 900 }
	n := count(3 * time.Second)
	checkFPS("after resize", n, 3)
	if cs := s.CaptureStats(); cs.Restarts != 1 || cs.Width != 1600 || cs.Height != 900 {
		t.Errorf("after resize: %+v, want 1 restart at 1600x900", cs)
	}

	// The curtain: paused with privacy_curtain, frames keep coming.
	s.SetCurtain(true)
	select {
	case e := <-s.Events():
		for e.Resized {
			e = <-s.Events()
		}
		if !e.Paused || e.PauseReason != protocol.PauseReasonPrivacyCurtain {
			t.Errorf("event %+v, want paused by the curtain", e)
		}
	case <-time.After(time.Second):
		t.Error("no pause event")
	}
	checkFPS("curtain", count(2*time.Second), 2)
	s.SetCurtain(false)
	t.Logf("capture stats %+v", s.CaptureStats())
}

// TestLinuxPresetSwitches changes the preset as liveSession.switchTo does (the next
// capture starts, then the previous one stops) while the encoders get live bitrate changes
// and forced IDRs, as the rate controller and PLIs cause. Without the drain in
// gstStream.Stop, NVENC's completion thread read the freed session and the process died
// with SIGSEGV in libnvcuvid. The freed session is a large malloc chunk: a fixed
// mmap threshold unmaps it every time, so the bug crashes at once instead of seconds later:
//
//	MALLOC_MMAP_THRESHOLD_=65536 go test -tags integration -run LinuxPresetSwitches ./internal/media/
func TestLinuxPresetSwitches(t *testing.T) {
	if !HasElement("glvideomixer") || !HasElement("nvh264enc") {
		t.Skip("no GL mixer or NVENC")
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	b, _ := NewLinuxBackend(LinuxOptions{TestPattern: "ball", TestWidth: 2560, TestHeight: 1440, Log: log})
	names := []string{"1080p60", "1440p60", "1080p120"}
	start := func(i int) Stream {
		p, _ := FindPreset(names[i%len(names)])
		layers, _ := p.Layers(AllRIDs)
		st, err := b.Start(context.Background(), Source{Kind: SourceTest}, Profile{Layers: layers, Encoder: EncoderNVENC, GOP: 10 * time.Second})
		if err != nil {
			t.Fatalf("start %s: %v", names[i%len(names)], err)
		}
		go func() {
			n := 0
			for f := range st.Video() {
				if n++; n%30 == 0 {
					for _, l := range layers {
						_ = st.SetBitrate(l.RID, l.Kbps/2+(n%7)*l.Kbps/14)
					}
					_ = st.RequestKeyframe(f.RID)
				}
			}
		}()
		return st
	}
	// Every switch used to leak the old pipeline's GL display and CUDA context, and about 38
	// of them exhausted something (TestLinuxStartStopCycles covers that now).
	const switches = 12
	cur := start(0)
	for i := 1; i <= switches; i++ {
		time.Sleep(2 * time.Second)
		next := start(i)
		t0 := time.Now()
		_ = cur.Stop()
		if d := time.Since(t0); d > drainTimeout+time.Second {
			t.Errorf("switch %d: stopping the old capture took %s", i, d)
		}
		cur = next
	}
	time.Sleep(2 * time.Second)
	_ = cur.Stop()
}

// TestLinuxStartStopCycles stops 50 NVENC captures in one process, half of them ended
// (stop, then start) and half switched (the next starts, then the previous stops, as a
// preset change does), and checks that threads, open files and this process's VRAM come
// back to what one capture left behind. Every stopped capture used to keep its GL display
// and CUDA context: +3 threads, +24 fds and +238 MiB of VRAM per cycle.
func TestLinuxStartStopCycles(t *testing.T) {
	if !HasElement("glvideomixer") || !HasElement("nvh264enc") {
		t.Skip("no GL mixer or NVENC")
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	b, _ := NewLinuxBackend(LinuxOptions{TestPattern: "ball", TestWidth: 1920, TestHeight: 1080, Log: log})
	names := []string{"1080p60", "1080p30"}
	start := func(i int) Stream {
		p, _ := FindPreset(names[i%len(names)])
		layers, _ := p.Layers(AllRIDs)
		st, err := b.Start(context.Background(), Source{Kind: SourceTest}, Profile{Layers: layers, Encoder: EncoderNVENC, GOP: 10 * time.Second})
		if err != nil {
			t.Fatalf("cycle %d: start %s: %v", i, names[i%len(names)], err)
		}
		go func() {
			for range st.Video() {
			}
		}()
		time.Sleep(300 * time.Millisecond)
		return st
	}
	// After a Stop the wrappers go at the next collection (collectSoon).
	settle := func() usage {
		time.Sleep(collectDelay + time.Second)
		return measureUsage()
	}
	vram := nvidiaSMI()
	_ = start(0).Stop()
	base := settle()
	t.Logf("after one capture: %+v", base)

	const cycles = 50
	var cur Stream
	for i := 1; i <= cycles; i++ {
		if i <= cycles/2 {
			_ = start(i).Stop()
		} else {
			next := start(i)
			if cur != nil {
				_ = cur.Stop()
			}
			cur = next
		}
		// Bail out early rather than take the GPU's memory from whoever is using it.
		if vram && i%10 == 0 {
			if u := measureUsage(); u.vramMiB > base.vramMiB+1024 {
				t.Fatalf("cycle %d: %d MiB of VRAM, %d after one capture", i, u.vramMiB, base.vramMiB)
			}
		}
	}
	_ = cur.Stop()
	end := settle()
	t.Logf("after %d more: %+v", cycles, end)
	// What stays is reused, not leaked: Go keeps the threads cgo calls blocked on, and
	// GStreamer's task pool its idle streaming threads. The leak grew by 3 threads a cycle.
	if d := end.threads - base.threads; d > 20 {
		t.Errorf("threads grew by %d over %d cycles", d, cycles)
	}
	if d := end.fds - base.fds; d > 24 {
		t.Errorf("open files grew by %d over %d cycles", d, cycles)
	}
	if vram {
		if d := end.vramMiB - base.vramMiB; d > 0 {
			t.Errorf("VRAM grew by %d MiB over %d cycles", d, cycles)
		}
	}
}

type usage struct{ threads, fds, vramMiB int }

func measureUsage() usage {
	u := usage{threads: -1}
	if b, err := os.ReadFile("/proc/self/status"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(l, "Threads:"); ok {
				u.threads, _ = strconv.Atoi(strings.TrimSpace(v))
			}
		}
	}
	if fds, err := os.ReadDir("/proc/self/fd"); err == nil {
		u.fds = len(fds)
	}
	u.vramMiB = processVRAM()
	return u
}

func nvidiaSMI() bool {
	_, err := exec.LookPath("nvidia-smi")
	return err == nil
}

// processVRAM is this process's GPU memory in MiB as nvidia-smi reports it (0 when it
// holds none).
func processVRAM() int {
	out, err := exec.Command("nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return 0
	}
	pid := strconv.Itoa(os.Getpid())
	for _, l := range strings.Split(string(out), "\n") {
		if p, mib, ok := strings.Cut(l, ","); ok && strings.TrimSpace(p) == pid {
			n, _ := strconv.Atoi(strings.TrimSpace(mib))
			return n
		}
	}
	return 0
}
