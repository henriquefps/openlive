// SPDX-License-Identifier: AGPL-3.0-only

package audio

import (
	"bytes"
	"cmp"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The voice sink: a virtual speaker the web plays Openlive voice into, so that
// sharing a browser window with its audio does not send the people in voice back to
// themselves. It is a pw-loopback: the capture side is an Audio/Sink ("Openlive – voice"),
// the playback side a stream that plays on the default output, or on the speakers the web
// names. Its output stream and every stream that plays into it are left out of app-audio
// capture (Graph.PlaysVoice).
//
// Like PWCapture it runs PipeWire's own tool as a child process: nothing to clean up in the
// graph when it ends (the nodes belong to the process), and the kernel ends it with the
// helper (procAttr). Leftovers of a helper that died anyway carry voiceSinkProp and the dead
// helper's pid, and are ended on the next check.

const (
	// VoiceSinkName is the sink's node.name.
	VoiceSinkName = "openlive-voice"
	voiceSinkProp = "openlive.voice-sink"
	helperPIDProp = "openlive.helper-pid"
	loopbackComm  = "pw-loopback"
)

// VoiceSinkPlan is what to do about the voice sinks in a graph.
type VoiceSinkPlan struct {
	// Live is a voice sink whose helper is running (this one or another instance's);
	// nil when there is none and this helper should make one.
	Live *Node
	// Stale are the pw-loopback processes of voice sinks whose helper is gone.
	Stale []int
}

// PlanVoiceSink reads the voice sinks of a graph. alive reports whether a helper pid
// still runs.
func (g Graph) PlanVoiceSink(alive func(pid int) bool) VoiceSinkPlan {
	var plan VoiceSinkPlan
	for _, n := range g.Nodes {
		if !n.VoiceSink {
			continue
		}
		if n.HelperPID > 0 && alive(n.HelperPID) {
			if n.MediaClass == sinkClass && plan.Live == nil {
				live := n
				plan.Live = &live
			}
			continue
		}
		if pid := g.Clients[n.ClientID]; pid > 0 && !slices.Contains(plan.Stale, pid) {
			plan.Stale = append(plan.Stale, pid)
		}
	}
	return plan
}

// VoiceOutput is the playback stream of the voice sink a helper made.
func (g Graph) VoiceOutput(helperPID int) (Node, bool) {
	for _, n := range g.Nodes {
		if n.VoiceSink && n.MediaClass == appOutputClass && n.HelperPID == helperPID {
			return n, true
		}
	}
	return Node{}, false
}

// SinkByLabel finds the speakers a browser lists under label (their node.description),
// never a voice sink.
func (g Graph) SinkByLabel(label string) (Node, bool) {
	label = strings.TrimSpace(label)
	if label == "" {
		return Node{}, false
	}
	for _, byName := range []bool{false, true} {
		for _, n := range g.Nodes {
			if n.MediaClass != sinkClass || n.VoiceSink {
				continue
			}
			if (!byName && n.Description == label) || (byName && n.Name == label) {
				return n, true
			}
		}
	}
	return Node{}, false
}

// VoiceSink keeps the voice sink while the helper runs.
type VoiceSink struct {
	label    string
	log      *slog.Logger
	self     int
	onChange func(present bool)
	interval time.Duration

	mu      sync.Mutex
	output  string // the speakers' label; "" is the default output
	applied string // the output target last written, as "<node>=<target>"
	present bool
	cmd     *exec.Cmd
	exited  chan struct{}
	spawned time.Time

	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

// StartVoiceSink makes the voice sink, described as label, and keeps it (PipeWire
// restarts end pw-loopback; the next check starts it again). onChange is called, from the
// check loop, when the sink appears or goes away.
func StartVoiceSink(label string, log *slog.Logger, onChange func(present bool)) (*VoiceSink, error) {
	for _, tool := range []string{loopbackComm, "pw-dump", "pw-metadata"} {
		if _, err := exec.LookPath(tool); err != nil {
			return nil, fmt.Errorf("voice sink: %s not found (install pipewire's tools): %w", tool, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	v := &VoiceSink{label: label, log: log, self: os.Getpid(), onChange: onChange, interval: 2 * time.Second, cancel: cancel, done: make(chan struct{})}
	go v.run(ctx)
	return v, nil
}

// Label is the sink's description, what browsers list it as.
func (v *VoiceSink) Label() string { return v.label }

// Present reports whether a voice sink is in the graph now.
func (v *VoiceSink) Present() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.present
}

// SetOutput picks the speakers the voice plays on by the browser's label; "" is the
// default output. A label no sink has falls back to the default.
func (v *VoiceSink) SetOutput(label string) {
	v.mu.Lock()
	v.output = strings.TrimSpace(label)
	v.mu.Unlock()
}

func (v *VoiceSink) run(ctx context.Context) {
	defer close(v.done)
	t := time.NewTicker(v.interval)
	defer t.Stop()
	for {
		if v.check(ctx) {
			// Just started: its nodes show up within a few hundred ms.
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
			v.check(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// check reads the graph once: ends leftovers, starts the sink when there is none, points
// its output at the chosen speakers and reports a change. It reports whether it started
// pw-loopback.
func (v *VoiceSink) check(ctx context.Context) (started bool) {
	g, err := dump(ctx)
	if err != nil {
		v.log.Debug("voice sink: read graph", "err", err)
		v.setPresent(false)
		return false
	}
	plan := g.PlanVoiceSink(helperAlive)
	for _, pid := range plan.Stale {
		if comm(pid) != loopbackComm {
			continue
		}
		v.log.Info("voice sink: ending a leftover of a helper that is gone", "pid", pid)
		terminate(pid)
	}
	if plan.Live == nil && !v.running() {
		var err error
		if started, err = v.spawn(); err != nil {
			v.log.Warn("voice sink: pw-loopback did not start", "err", err)
		}
	}
	v.applyOutput(ctx, g)
	v.setPresent(plan.Live != nil)
	return started
}

func (v *VoiceSink) setPresent(present bool) {
	v.mu.Lock()
	changed := v.present != present
	v.present = present
	v.mu.Unlock()
	if changed {
		v.log.Info("voice sink", "present", present, "label", v.label)
		if v.onChange != nil {
			v.onChange(present)
		}
	}
}

func (v *VoiceSink) running() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.cmd == nil {
		return false
	}
	select {
	case <-v.exited:
		return false
	default:
		return true
	}
}

// spawn starts pw-loopback, at most once every 5 s.
func (v *VoiceSink) spawn() (bool, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if time.Since(v.spawned) < 5*time.Second {
		return false, nil
	}
	v.spawned = time.Now()
	mark := fmt.Sprintf("%s=true %s=%d", voiceSinkProp, helperPIDProp, v.self)
	cmd := exec.Command(loopbackComm, "--name", VoiceSinkName,
		"--capture-props", fmt.Sprintf("media.class=%s node.name=%s node.description=%s %s audio.position=[FL,FR]",
			sinkClass, VoiceSinkName, strconv.Quote(v.label), mark),
		"--playback-props", fmt.Sprintf("node.name=%s.output node.description=%s media.role=Communication node.dont-reconnect=false %s",
			VoiceSinkName, strconv.Quote(v.label), mark))
	cmd.SysProcAttr = procAttr()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return false, err
	}
	exited := make(chan struct{})
	v.cmd, v.exited, v.applied = cmd, exited, ""
	go func() {
		err := cmd.Wait()
		close(exited)
		v.mu.Lock()
		current := v.cmd == cmd
		v.mu.Unlock()
		if current {
			v.log.Warn("voice sink: pw-loopback exited", "err", err, "stderr", strings.TrimSpace(stderr.String()))
		}
	}()
	v.log.Info("voice sink: started", "pid", cmd.Process.Pid, "label", v.label)
	return true, nil
}

// applyOutput points this helper's loopback at the chosen speakers through the default
// metadata (target.object), the way a mixer moves a stream; without one it follows the
// default output.
func (v *VoiceSink) applyOutput(ctx context.Context, g Graph) {
	out, ok := g.VoiceOutput(v.self)
	if !ok {
		return
	}
	v.mu.Lock()
	label := v.output
	v.mu.Unlock()
	target := ""
	if label != "" {
		if s, ok := g.SinkByLabel(label); ok {
			target = s.Name
		} else {
			v.log.Debug("voice sink: no speakers labelled so; the default output", "label", label)
		}
	}
	key := fmt.Sprintf("%d=%s", out.ID, target)
	v.mu.Lock()
	same := v.applied == key
	v.mu.Unlock()
	if same {
		return
	}
	id := strconv.FormatUint(uint64(out.ID), 10)
	args := []string{"-n", "default", id, "target.object", target}
	if target == "" {
		args = []string{"-n", "default", "-d", id, "target.object"}
	}
	if b, err := exec.CommandContext(ctx, "pw-metadata", args...).CombinedOutput(); err != nil {
		v.log.Warn("voice sink: set the output", "target", target, "err", err, "out", strings.TrimSpace(string(b)))
		return
	}
	v.mu.Lock()
	v.applied = key
	v.mu.Unlock()
	v.log.Info("voice sink: output", "speakers", cmp.Or(target, "default"))
}

// Close removes the sink: pw-loopback ends and its nodes go with it.
func (v *VoiceSink) Close() error {
	var err error
	v.once.Do(func() {
		v.cancel()
		<-v.done
		v.mu.Lock()
		cmd, exited := v.cmd, v.exited
		v.cmd = nil
		v.mu.Unlock()
		if cmd == nil {
			return
		}
		terminate(cmd.Process.Pid)
		select {
		case <-exited:
		case <-time.After(2 * time.Second):
			err = cmd.Process.Kill()
			<-exited
		}
	})
	return err
}

// helperAlive reports whether a helper pid runs (any process with that pid: a reused pid
// keeps a leftover for one more helper lifetime at worst, never ends a live one).
func helperAlive(pid int) bool {
	_, err := os.Stat(fmt.Sprintf("/proc/%d", pid))
	return err == nil
}

// comm is a process's command name, from /proc.
func comm(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
