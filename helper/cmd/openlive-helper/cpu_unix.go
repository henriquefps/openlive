// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"syscall"
	"time"
)

// processCPUTime is the CPU time (user + system) this process has used so far.
func processCPUTime() (time.Duration, bool) {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0, false
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano()), true
}
