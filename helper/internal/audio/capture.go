// SPDX-License-Identifier: AGPL-3.0-only

package audio

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PCM format of every capture: what the Opus encoder downstream expects.
const (
	SampleRate = 48000
	Channels   = 2
)

// Capture is a running per-app capture. PCM carries interleaved s16le at SampleRate and
// Channels; it reads silence-free gaps (nothing) while the app plays nothing.
type Capture interface {
	// PCM is the read end of the raw audio pipe. It stays valid until Stop.
	PCM() *os.File
	// Linked reports how many of the app's playback streams are linked now.
	Linked() int
	Stop() error
}

// Starter starts a capture for one app; tests and other OS backends replace it.
type Starter func(ctx context.Context, sel Selector, log *slog.Logger) (Capture, error)

// ListApps lists the applications playing audio now.
func ListApps(ctx context.Context) ([]App, error) {
	g, err := dump(ctx)
	if err != nil {
		return nil, err
	}
	return g.Apps(), nil
}

// dump runs pw-dump (read-only) and parses the graph.
func dump(ctx context.Context) (Graph, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "pw-dump", "--no-colors").Output()
	if err != nil {
		return Graph{}, fmt.Errorf("pw-dump: %w", err)
	}
	return ParseDump(bytes.NewReader(out))
}

// PWCapture is the capture built from PipeWire's own tools, the approach an early experiment
// proved: pw-record as the unconnected capture node, pw-link for the links, pw-dump to
// read the graph.
//
// The design asks for libpipewire. These tools are thin libpipewire clients, so the graph
// sees exactly what an in-process client would create (a Stream/Input/Audio node with
// node.autoconnect=false and plain port links), and never GStreamer's PipeWire audio
// elements or a null sink, which stalled the whole graph in early experiments. Running them as
// child processes also keeps an audio failure out of the helper's own process, which
// the design requires for screen capture. The in-process binding replaces this type behind
// the Capture interface; see helper/README.md.
type PWCapture struct {
	sel      Selector
	node     string
	log      *slog.Logger
	cmd      *exec.Cmd
	pcm      *os.File
	interval time.Duration

	mu     sync.Mutex
	linked int

	cancel context.CancelFunc
	done   chan struct{} // the link loop has returned
	exited chan struct{} // pw-record has exited
	once   sync.Once
}

// StartPW starts pw-record as an unconnected capture node and keeps it linked to the
// selected app's playback streams (apps open and close streams while they play).
func StartPW(ctx context.Context, sel Selector, log *slog.Logger) (Capture, error) {
	if sel.empty() {
		return nil, errors.New("audio: no app selected")
	}
	for _, tool := range []string{"pw-record", "pw-link", "pw-dump"} {
		if _, err := exec.LookPath(tool); err != nil {
			return nil, fmt.Errorf("audio: %s not found (install pipewire's tools): %w", tool, err)
		}
	}
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	node := fmt.Sprintf("openlive-helper-audio-%d", os.Getpid())
	cmd := exec.Command("pw-record", "--raw", "--rate", strconv.Itoa(SampleRate), "--channels", strconv.Itoa(Channels),
		"--format", "s16", "--latency", "10ms",
		"-P", fmt.Sprintf("{ node.name=%s node.description=\"Openlive app audio\" node.autoconnect=false node.dont-reconnect=true }", node), "-")
	cmd.Stdout = w
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		_ = r.Close()
		_ = w.Close()
		return nil, fmt.Errorf("audio: pw-record: %w", err)
	}
	_ = w.Close()
	cctx, cancel := context.WithCancel(context.Background())
	c := &PWCapture{sel: sel, node: node, log: log, cmd: cmd, pcm: r, interval: time.Second, cancel: cancel, done: make(chan struct{}), exited: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		close(c.exited)
		select {
		case <-cctx.Done():
		default:
			log.Warn("audio: pw-record exited", "err", err, "stderr", strings.TrimSpace(stderr.String()))
		}
	}()
	// The node appears in the graph a few ms after the process starts.
	if err := c.waitNode(ctx, 5*time.Second); err != nil {
		close(c.done)
		_ = c.Stop()
		return nil, err
	}
	go c.keepLinked(cctx)
	return c, nil
}

func (c *PWCapture) waitNode(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		g, err := dump(ctx)
		if err == nil {
			if n, ok := g.NodeByName(c.node); ok && len(g.PortsOf(n.ID, false)) > 0 {
				return c.sync(ctx, g)
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("audio: capture node %s has no ports after %s", c.node, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// keepLinked re-reads the graph every interval and fixes the links.
func (c *PWCapture) keepLinked(ctx context.Context) {
	defer close(c.done)
	t := time.NewTicker(c.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		g, err := dump(ctx)
		if err != nil {
			c.log.Debug("audio: read graph", "err", err)
			continue
		}
		if err := c.sync(ctx, g); err != nil {
			c.log.Warn("audio: link", "err", err)
		}
	}
}

// sync applies the plan for one graph snapshot.
func (c *PWCapture) sync(ctx context.Context, g Graph) error {
	n, ok := g.NodeByName(c.node)
	if !ok {
		return fmt.Errorf("capture node %s is gone", c.node)
	}
	plan := g.PlanCapture(n.ID, c.sel)
	var errs []error
	for _, l := range plan.Remove {
		if out, err := exec.CommandContext(ctx, "pw-link", "-d", strconv.FormatUint(uint64(l.ID), 10)).CombinedOutput(); err != nil {
			errs = append(errs, fmt.Errorf("unlink %d: %v %s", l.ID, err, bytes.TrimSpace(out)))
		} else {
			c.log.Info("audio: removed a link into the capture node", "out", l.Out, "in", l.In)
		}
	}
	for _, l := range plan.Create {
		out, err := exec.CommandContext(ctx, "pw-link", strconv.FormatUint(uint64(l.Out), 10), strconv.FormatUint(uint64(l.In), 10)).CombinedOutput()
		if err != nil && !bytes.Contains(out, []byte("File exists")) {
			errs = append(errs, fmt.Errorf("link %d→%d: %v %s", l.Out, l.In, err, bytes.TrimSpace(out)))
			continue
		}
		c.log.Debug("audio: linked", "out", l.Out, "in", l.In)
	}
	sources := g.Sources(c.sel)
	c.mu.Lock()
	changed := c.linked != len(sources)
	c.linked = len(sources)
	c.mu.Unlock()
	if changed {
		var names []string
		for _, s := range sources {
			names = append(names, fmt.Sprintf("%s (node %d, pid %d)", s.appName(), s.ID, s.PID))
		}
		c.log.Info("audio: capturing", "app", c.sel.String(), "streams", len(sources), "nodes", strings.Join(names, ", "))
	}
	return errors.Join(errs...)
}

func (c *PWCapture) PCM() *os.File { return c.pcm }

func (c *PWCapture) Linked() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.linked
}

// Stop ends pw-record (its node, ports and links go with it) and the link loop.
func (c *PWCapture) Stop() error {
	c.once.Do(func() {
		c.cancel()
		<-c.done
		_ = c.cmd.Process.Signal(os.Interrupt)
		select {
		case <-c.exited:
		case <-time.After(2 * time.Second):
			_ = c.cmd.Process.Kill()
			<-c.exited
		}
		_ = c.pcm.Close()
	})
	return nil
}

// Descends reports whether pid is ancestor or one of its descendants, from /proc.
func Descends(pid, ancestor int) bool {
	for i := 0; i < 64 && pid > 1; i++ {
		if pid == ancestor {
			return true
		}
		pid = parentPID(pid)
	}
	return false
}

// parentPID reads the ppid field of /proc/<pid>/stat (after the parenthesised comm, which
// may itself contain spaces and parentheses).
func parentPID(pid int) int {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0
	}
	return ParseStatPPID(string(b))
}

// ParseStatPPID extracts the ppid from a /proc/<pid>/stat line.
func ParseStatPPID(stat string) int {
	i := strings.LastIndexByte(stat, ')')
	if i < 0 {
		return 0
	}
	f := strings.Fields(stat[i+1:])
	if len(f) < 2 {
		return 0
	}
	ppid, _ := strconv.Atoi(f[1])
	return ppid
}
