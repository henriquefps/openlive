// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package single

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestAcquire(t *testing.T) {
	dir := t.TempDir()
	a, err := Acquire(dir, "https://a.example")
	if err != nil {
		t.Fatal(err)
	}
	// flock locks belong to the open file, so a second open in this process conflicts
	// like a second process would.
	_, err = Acquire(dir, "https://a.example")
	var running *ErrRunning
	if !errors.As(err, &running) || running.PID != os.Getpid() || running.Instance != "https://a.example" {
		t.Fatalf("second acquire: %v", err)
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("pid %d", os.Getpid())) || !strings.Contains(err.Error(), "already running for https://a.example") {
		t.Errorf("message: %s", err)
	}
	// Another instance has its own lock.
	b, err := Acquire(dir, "https://b.example")
	if err != nil {
		t.Fatalf("other instance: %v", err)
	}
	defer func() { _ = b.Release() }()
	if err := a.Release(); err != nil {
		t.Fatal(err)
	}
	again, err := Acquire(dir, "https://a.example")
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	_ = again.Release()
}

func TestDir(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	if d := Dir(); d != "/run/user/1000/openlive-helper" {
		t.Errorf("Dir = %s", d)
	}
	if Path("/x", "https://a") == Path("/x", "https://b") {
		t.Error("instances share a lock")
	}
}
