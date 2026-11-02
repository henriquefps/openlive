// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

// On Linux "run" is started by a .desktop entry (the menu, XDG autostart, the Flatpak and
// the tarball all go through one), which has no Restart= of its own, so "run" supervises
// itself: it starts a copy of itself as a child and starts it again when it crashes. A
// crash ends the stream, but the helper comes back to the tray and the hub, and the web can
// start the next one. On macOS launchd does this (the LaunchAgent's KeepAlive).

// supervisedEnv marks the supervised child; set to anything, "run" runs in-process.
const supervisedEnv = "OPENLIVE_HELPER_SUPERVISED"

// restartPolicy decides whether a crashed child starts again: after a growing delay, and
// not after maxRestarts crashes within window (a crash loop is left stopped, not spun).
type restartPolicy struct {
	maxRestarts int
	window      time.Duration
	// minUptime: a child that exits with code 2 sooner than this had bad flags, not a crash.
	minUptime time.Duration
	delays    []time.Duration
	crashes   []time.Time
}

func newRestartPolicy() *restartPolicy {
	return &restartPolicy{
		maxRestarts: 5,
		window:      10 * time.Minute,
		minUptime:   10 * time.Second,
		delays:      []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second},
	}
}

// crashed says whether the child's end was a crash: a fatal signal (SIGSEGV, SIGABRT,
// SIGBUS, SIGKILL from the OOM killer...) or a Go panic (exit 2) after minUptime. A
// clean exit, an error exit and the stop signals (Ctrl+C, logout) are not.
func (p *restartPolicy) crashed(code int, sig syscall.Signal, signaled bool, uptime time.Duration) bool {
	if signaled {
		return sig != syscall.SIGINT && sig != syscall.SIGTERM && sig != syscall.SIGHUP
	}
	return code == 2 && uptime >= p.minUptime
}

// next records a crash at now and returns how long to wait before the restart, or false
// when the crashes within the window used up maxRestarts.
func (p *restartPolicy) next(now time.Time) (time.Duration, bool) {
	kept := p.crashes[:0]
	for _, t := range p.crashes {
		if now.Sub(t) < p.window {
			kept = append(kept, t)
		}
	}
	p.crashes = append(kept, now)
	n := len(p.crashes)
	if n > p.maxRestarts {
		return 0, false
	}
	return p.delays[min(n, len(p.delays))-1], true
}

// superviseRun runs "run" (args are os.Args) in a child and returns its exit code, after
// restarting it on crashes. ok is false when this process is the child (or the
// executable is unknown): the caller then runs the command itself.
func superviseRun(args []string, log *slog.Logger) (code int, ok bool) {
	if os.Getenv(supervisedEnv) != "" {
		return 0, false
	}
	bin, err := os.Executable()
	if err != nil {
		return 0, false
	}
	// The stop signals go to the child, which shuts down; the supervisor then exits with it.
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigs)
	policy := newRestartPolicy()
	for {
		cmd := exec.Command(bin, args[1:]...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		cmd.Env = append(os.Environ(), supervisedEnv+"=1")
		start := time.Now()
		if err := cmd.Start(); err != nil {
			log.Error("could not start the helper", "err", err)
			return 1, true
		}
		exited := make(chan error, 1)
		go func() { exited <- cmd.Wait() }()
		stopping := false
		var werr error
	wait:
		for {
			select {
			case s := <-sigs:
				stopping = true
				_ = cmd.Process.Signal(s)
			case werr = <-exited:
				break wait
			}
		}
		var ee *exec.ExitError
		if werr != nil && !errors.As(werr, &ee) {
			log.Error("lost the helper process", "err", werr)
			return 1, true
		}
		st := cmd.ProcessState
		ws, _ := st.Sys().(syscall.WaitStatus)
		code := st.ExitCode()
		if ws.Signaled() {
			code = 128 + int(ws.Signal())
		}
		if stopping || !policy.crashed(st.ExitCode(), ws.Signal(), ws.Signaled(), time.Since(start)) {
			return code, true
		}
		how := fmt.Sprintf("exit code %d", st.ExitCode())
		if ws.Signaled() {
			how = ws.Signal().String()
		}
		delay, again := policy.next(time.Now())
		if !again {
			log.Error("the helper keeps crashing; not restarting it", "how", how,
				"crashes", policy.maxRestarts+1, "within", policy.window)
			return code, true
		}
		log.Warn("the helper crashed; restarting it", "how", how, "after", delay)
		select {
		case <-time.After(delay):
		case <-sigs:
			return code, true
		}
	}
}
