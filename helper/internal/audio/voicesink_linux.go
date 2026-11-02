// SPDX-License-Identifier: AGPL-3.0-only

package audio

import "syscall"

// procAttr ends pw-loopback when the helper dies, so a crash leaves no voice sink behind.
func procAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}

func terminate(pid int) { _ = syscall.Kill(pid, syscall.SIGTERM) }
