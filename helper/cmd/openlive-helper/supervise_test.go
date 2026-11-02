// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRestartPolicyCrashed(t *testing.T) {
	p := newRestartPolicy()
	for _, c := range []struct {
		name     string
		code     int
		sig      syscall.Signal
		signaled bool
		uptime   time.Duration
		want     bool
	}{
		{"SIGSEGV", 0, syscall.SIGSEGV, true, time.Hour, true},
		{"SIGABRT", 0, syscall.SIGABRT, true, time.Second, true},
		{"OOM kill", 0, syscall.SIGKILL, true, time.Hour, true},
		{"Ctrl+C", 0, syscall.SIGINT, true, time.Hour, false},
		{"logout", 0, syscall.SIGTERM, true, time.Hour, false},
		{"Go panic", 2, 0, false, time.Minute, true},
		{"bad flags", 2, 0, false, time.Millisecond, false},
		{"Quit", 0, 0, false, time.Hour, false},
		{"error", 1, 0, false, time.Hour, false},
	} {
		if got := p.crashed(c.code, c.sig, c.signaled, c.uptime); got != c.want {
			t.Errorf("%s: crashed = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestRestartPolicyStopsACrashLoop(t *testing.T) {
	p := newRestartPolicy()
	now := time.Unix(1_000_000, 0)
	var delays []time.Duration
	for i := 0; i < p.maxRestarts; i++ {
		d, ok := p.next(now)
		if !ok {
			t.Fatalf("crash %d: no restart", i+1)
		}
		delays = append(delays, d)
		now = now.Add(time.Minute)
	}
	for i := 1; i < len(delays); i++ {
		if delays[i] < delays[i-1] {
			t.Errorf("delays %v do not grow", delays)
		}
	}
	if _, ok := p.next(now); ok {
		t.Fatalf("restarted after %d crashes within %s", p.maxRestarts+1, p.window)
	}
	// Crashes long ago no longer count: a helper that crashes once a day keeps coming back.
	if _, ok := p.next(now.Add(2 * p.window)); !ok {
		t.Fatal("no restart after a quiet window")
	}
}

// TestSuperviseRunRestartsACrash runs the supervisor on this test binary: the child
// (TestSupervisedChild) kills itself with SIGKILL twice, then exits 0.
func TestSuperviseRunRestartsACrash(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the supervisor runs on Linux")
	}
	if testing.Short() {
		t.Skip("waits for two restart delays (3 s)")
	}
	t.Setenv(supervisedEnv, "")
	if err := os.Unsetenv(supervisedEnv); err != nil {
		t.Fatal(err)
	}
	runs := filepath.Join(t.TempDir(), "runs")
	t.Setenv("SUPERVISE_TEST_RUNS", runs)
	code, ok := superviseRun([]string{"openlive-helper", "-test.run=^TestSupervisedChild$"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if !ok || code != 0 {
		t.Fatalf("superviseRun = %d, %v; want 0, true", code, ok)
	}
	raw, _ := os.ReadFile(runs)
	if n := strings.Count(string(raw), "x"); n != 3 {
		t.Fatalf("the child ran %d times, want 3", n)
	}
}

// TestSupervisedChild is the child of TestSuperviseRunRestartsACrash.
func TestSupervisedChild(t *testing.T) {
	runs := os.Getenv("SUPERVISE_TEST_RUNS")
	if runs == "" || os.Getenv(supervisedEnv) == "" {
		t.Skip("only run by TestSuperviseRunRestartsACrash")
	}
	f, err := os.OpenFile(runs, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("x")
	_ = f.Close()
	raw, _ := os.ReadFile(runs)
	if len(raw) < 3 {
		_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
	}
}
