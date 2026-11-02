// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration && linux

package audio

import (
	"context"
	"encoding/binary"
	"io"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// TestVoiceSink runs the voice sink on the real graph: it appears with its
// label, plays on real speakers and follows the chosen ones; a process that plays one
// tone into the voice sink and another to the speakers is captured without the voice
// (by links and by the PCM read); and the sink is gone after Close.
//
//	go test -tags integration -run TestVoiceSink -v ./internal/audio/
//
// The tones are quiet (-50 dBFS) and go to a second sink when there is one, so the
// person at the computer barely hears a thing.
func TestVoiceSink(t *testing.T) {
	for _, tool := range []string{"pw-loopback", "pw-play", "pw-dump", "pw-link", "pw-record", "pw-metadata"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not found", tool)
		}
	}
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	const label = "Openlive – voice (test)"
	present := make(chan bool, 4)
	vs, err := StartVoiceSink(label, log, func(p bool) { present <- p })
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = vs.Close()
		}
	}()
	waitPresent(t, present, true)

	g := mustDump(t)
	sinks := g.VoiceSinks()
	if len(sinks) != 1 || sinks[0].Description != label || sinks[0].HelperPID != os.Getpid() {
		t.Fatalf("voice sinks = %+v", sinks)
	}
	// Quiet speakers for the test: a sink other than the default when there is one.
	speakers := otherSink(t)
	if speakers != "" {
		vs.SetOutput(descriptionOf(g, speakers))
	}
	out := waitFor(t, "the voice sink plays on the speakers", func(g Graph) bool {
		to := linkedSinks(g, mustOutput(t, g).ID)
		return len(to) > 0 && (speakers == "" || to[0] == speakers)
	})
	t.Logf("voice sink output plays on %v", linkedSinks(out, mustOutput(t, out).ID))

	// One process tree: a tone into the voice sink (the voice), another to the speakers
	// (the shared window's own audio), as a browser would.
	dir := t.TempDir()
	voice, app := filepath.Join(dir, "voice.wav"), filepath.Join(dir, "app.wav")
	writeTone(t, voice, 440, 9)
	writeTone(t, app, 1000, 3)
	appTarget := ""
	if speakers != "" {
		appTarget = "--target=" + speakers
	}
	// The voice goes through PulseAudio like a browser's (setSinkId), where paplay is there.
	player := `pw-play --target=` + VoiceSinkName
	if _, err := exec.LookPath("paplay"); err == nil {
		player = `paplay --device=` + VoiceSinkName
	}
	sh := exec.Command("sh", "-c", player+` "$1" & sleep 5; pw-play `+appTarget+` "$2" & wait`, "sh", voice, app)
	sh.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := sh.Start(); err != nil {
		t.Fatal(err)
	}
	// The whole group: sh and both pw-play.
	stopPlay := func() { _ = syscall.Kill(-sh.Process.Pid, syscall.SIGKILL); _ = sh.Wait() }
	defer stopPlay()
	sel := Selector{PID: sh.Process.Pid, Descends: Descends}

	waitFor(t, "the voice stream plays into the voice sink", func(g Graph) bool {
		for _, n := range g.Nodes {
			if n.MediaClass == appOutputClass && sel.matches(n) && g.PlaysVoice(n) {
				return true
			}
		}
		return false
	})
	c, err := StartPW(ctx, sel, log)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Stop() }()
	pcm := make(chan []byte, 8)
	go func() {
		for {
			b := make([]byte, SampleRate*Channels*2/10)
			if _, err := io.ReadFull(c.PCM(), b); err != nil {
				close(pcm)
				return
			}
			pcm <- b
		}
	}()
	// Only the voice plays for the first 5 s: the capture hears nothing.
	quiet := peakFor(pcm, 2*time.Second)
	if c.Linked() != 0 || quiet != 0 {
		t.Fatalf("voice captured: %d streams linked, peak %d", c.Linked(), quiet)
	}
	t.Logf("voice alone: 0 streams linked, peak %d", quiet)
	waitFor(t, "the app stream is linked", func(Graph) bool { return c.Linked() == 1 })
	loud := peakFor(pcm, 2*time.Second)
	if loud == 0 {
		t.Fatal("the app's own audio was not captured")
	}
	t.Logf("voice and app: %d stream linked (the app), peak %d", c.Linked(), loud)
	g = mustDump(t)
	node, _ := g.NodeByName(c.(*PWCapture).node)
	if plan := g.PlanCapture(node.ID, sel); !plan.Empty() {
		t.Errorf("graph not as planned: %+v", plan)
	}
	_ = c.Stop()
	stopPlay()

	// Back to the default output, then gone.
	vs.SetOutput("")
	waitFor(t, "the voice sink follows the default output", func(g Graph) bool {
		to := linkedSinks(g, mustOutput(t, g).ID)
		return len(to) > 0 && to[0] == defaultSink(t)
	})
	closed = true
	if err := vs.Close(); err != nil {
		t.Fatal(err)
	}
	if left := mustDump(t).VoiceSinks(); len(left) != 0 {
		t.Fatalf("voice sink left behind: %+v", left)
	}
	for _, n := range mustDump(t).Nodes {
		if n.VoiceSink {
			t.Fatalf("voice node left behind: %+v", n)
		}
	}
}

// TestVoiceSinkEndsLeftovers: a voice sink whose helper is gone (a pid that does not
// run) is ended, and this helper makes its own.
func TestVoiceSinkEndsLeftovers(t *testing.T) {
	if _, err := exec.LookPath("pw-loopback"); err != nil {
		t.Skip("pw-loopback not found")
	}
	const dead = 4194000 // above any pid_max in use
	mark := voiceSinkProp + "=true " + helperPIDProp + "=" + itoa(dead)
	left := exec.Command("pw-loopback", "--name", "openlive-leftover",
		"--capture-props", "media.class=Audio/Sink node.name="+VoiceSinkName+" node.description=Leftover "+mark,
		"--playback-props", "node.name="+VoiceSinkName+".output "+mark)
	if err := left.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = left.Wait(); close(exited) }()
	defer func() { _ = left.Process.Kill() }()
	waitFor(t, "the leftover appears", func(g Graph) bool { return len(g.VoiceSinks()) == 1 })

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	present := make(chan bool, 4)
	vs, err := StartVoiceSink("Openlive – voice (test)", log, func(p bool) { present <- p })
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vs.Close() }()
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatal("the leftover pw-loopback was not ended")
	}
	waitPresent(t, present, true)
	g := waitFor(t, "only this helper's sink", func(g Graph) bool {
		s := g.VoiceSinks()
		return len(s) == 1 && s[0].HelperPID == os.Getpid()
	})
	t.Logf("leftover ended; sink now %+v", g.VoiceSinks()[0].Description)
}

func waitPresent(t *testing.T, ch <-chan bool, want bool) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("present = %v", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the voice sink did not appear")
	}
}

func mustDump(t *testing.T) Graph {
	t.Helper()
	g, err := dump(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func mustOutput(t *testing.T, g Graph) Node {
	t.Helper()
	n, ok := g.VoiceOutput(os.Getpid())
	if !ok {
		t.Fatal("no voice sink output")
	}
	return n
}

func waitFor(t *testing.T, what string, ok func(Graph) bool) Graph {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if g, err := dump(context.Background()); err == nil && ok(g) {
			return g
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timed out: %s", what)
	return Graph{}
}

// linkedSinks are the node names of the sinks a node's output is linked to.
func linkedSinks(g Graph, node uint32) []string {
	portNode := map[uint32]uint32{}
	for _, p := range g.Ports {
		portNode[p.ID] = p.NodeID
	}
	var out []string
	for _, l := range g.Links {
		if portNode[l.Out] != node {
			continue
		}
		for _, n := range g.Nodes {
			if n.ID == portNode[l.In] && n.MediaClass == sinkClass && (len(out) == 0 || out[len(out)-1] != n.Name) {
				out = append(out, n.Name)
			}
		}
	}
	return out
}

func defaultSink(t *testing.T) string {
	t.Helper()
	b, err := exec.Command("pactl", "get-default-sink").Output()
	if err != nil {
		t.Skipf("pactl: %v", err)
	}
	return string(trimNL(b))
}

// otherSink is a hardware sink that is not the default, "" when there is none.
func otherSink(t *testing.T) string {
	def := defaultSink(t)
	for _, n := range mustDump(t).Nodes {
		if n.MediaClass == sinkClass && !n.VoiceSink && n.Name != def && len(n.Name) > 5 && n.Name[:5] == "alsa_" {
			return n.Name
		}
	}
	return ""
}

func descriptionOf(g Graph, name string) string {
	n, _ := g.NodeByName(name)
	return n.Description
}

func trimNL(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// writeTone writes a quiet stereo s16 WAV tone.
func writeTone(t *testing.T, path string, hz float64, seconds int) {
	t.Helper()
	frames := SampleRate * seconds
	data := make([]byte, frames*4)
	for i := range frames {
		v := int16(100 * math.Sin(2*math.Pi*hz*float64(i)/SampleRate))
		binary.LittleEndian.PutUint16(data[i*4:], uint16(v))
		binary.LittleEndian.PutUint16(data[i*4+2:], uint16(v))
	}
	h := make([]byte, 44)
	copy(h, "RIFF")
	binary.LittleEndian.PutUint32(h[4:], uint32(36+len(data)))
	copy(h[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(h[16:], 16)
	binary.LittleEndian.PutUint16(h[20:], 1)
	binary.LittleEndian.PutUint16(h[22:], 2)
	binary.LittleEndian.PutUint32(h[24:], SampleRate)
	binary.LittleEndian.PutUint32(h[28:], SampleRate*4)
	binary.LittleEndian.PutUint16(h[32:], 4)
	binary.LittleEndian.PutUint16(h[34:], 16)
	copy(h[36:], "data")
	binary.LittleEndian.PutUint32(h[40:], uint32(len(data)))
	if err := os.WriteFile(path, append(h, data...), 0o600); err != nil {
		t.Fatal(err)
	}
}

// peakFor is the loudest sample read in d.
func peakFor(pcm <-chan []byte, d time.Duration) int {
	peak := 0
	deadline := time.After(d)
	for {
		select {
		case b, ok := <-pcm:
			if !ok {
				return peak
			}
			for i := 0; i+1 < len(b); i += 2 {
				v := int(int16(binary.LittleEndian.Uint16(b[i:])))
				if v < 0 {
					v = -v
				}
				peak = max(peak, v)
			}
		case <-deadline:
			return peak
		}
	}
}
