// SPDX-License-Identifier: AGPL-3.0-only

// Package single keeps one "openlive-helper run" per instance: a second one exits with a
// clear message instead of fighting the first over the hub socket (the hub would close
// the older one with 4002, and both would reconnect forever).
package single

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ErrRunning: another helper runs for this instance.
type ErrRunning struct {
	Instance string
	// PID of the other helper, 0 when unknown.
	PID int
}

func (e *ErrRunning) Error() string {
	if e.PID > 0 {
		return fmt.Sprintf("the helper is already running for %s (pid %d); look for it in the system tray, or stop it first", e.Instance, e.PID)
	}
	return fmt.Sprintf("the helper is already running for %s; look for it in the system tray, or stop it first", e.Instance)
}

// Dir is where the locks live: $XDG_RUNTIME_DIR/openlive-helper (per user, cleared at
// logout), else a per-user directory in the temp dir.
func Dir() string {
	if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" {
		return filepath.Join(d, "openlive-helper")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("openlive-helper-%d", os.Getuid()))
}

// Path is the lock file of one instance.
func Path(dir, instance string) string {
	sum := sha256.Sum256([]byte(instance))
	return filepath.Join(dir, "run-"+hex.EncodeToString(sum[:8])+".lock")
}

// Lock is a held instance lock; the OS releases it when the process ends, even on a crash.
type Lock struct {
	f *os.File
}

// Acquire takes the lock of instance in dir, or returns *ErrRunning.
func Acquire(dir, instance string) (*Lock, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(Path(dir, instance), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := tryLock(f); err != nil {
		raw := make([]byte, 32)
		n, _ := f.ReadAt(raw, 0)
		_ = f.Close()
		if errors.Is(err, errLocked) {
			pid, _ := strconv.Atoi(strings.TrimSpace(string(raw[:n])))
			return nil, &ErrRunning{Instance: instance, PID: pid}
		}
		return nil, fmt.Errorf("single-instance lock: %w", err)
	}
	_ = f.Truncate(0)
	_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	return &Lock{f: f}, nil
}

// Release lets another helper run.
func (l *Lock) Release() error {
	_ = unlock(l.f)
	return l.f.Close()
}

var errLocked = errors.New("locked")
