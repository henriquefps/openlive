// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package sidecar

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"syscall"
)

// Spawn runs bin with one end of a socketpair as fd 3 and returns the other end, the running
// command and its stderr.
func Spawn(bin string, args ...string) (net.Conn, *exec.Cmd, io.ReadCloser, error) {
	// The fork lock keeps the pair out of a child another goroutine starts before both ends
	// are close-on-exec (darwin has no SOCK_CLOEXEC); ExtraFiles clears it on the child's fd 3.
	syscall.ForkLock.RLock()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err == nil {
		syscall.CloseOnExec(fds[0])
		syscall.CloseOnExec(fds[1])
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("socketpair: %w", err)
	}
	parent, child := os.NewFile(uintptr(fds[0]), "sidecar"), os.NewFile(uintptr(fds[1]), "sidecar-child")
	conn, err := net.FileConn(parent)
	_ = parent.Close()
	if err != nil {
		_ = child.Close()
		return nil, nil, nil, err
	}
	// Its own pipe for stderr, so cmd.Wait never races the reader.
	logR, logW, err := os.Pipe()
	if err != nil {
		_ = child.Close()
		_ = conn.Close()
		return nil, nil, nil, err
	}
	cmd := exec.Command(bin, args...)
	cmd.ExtraFiles = []*os.File{child}
	cmd.Stderr = logW
	err = cmd.Start()
	_ = child.Close()
	_ = logW.Close()
	if err != nil {
		_ = logR.Close()
		_ = conn.Close()
		return nil, nil, nil, err
	}
	return conn, cmd, logR, nil
}
