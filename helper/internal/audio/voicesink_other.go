// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package audio

import (
	"os"
	"syscall"
)

// procAttr: PipeWire, and so the voice sink, is Linux only.
func procAttr() *syscall.SysProcAttr { return nil }

func terminate(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Kill()
	}
}
