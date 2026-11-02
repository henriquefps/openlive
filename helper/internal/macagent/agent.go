// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

// Package macagent runs the helper's presence on the macOS desktop: the menu bar item, the
// notifications (UserNotifications) and the global shortcuts (Carbon hot keys). They live in
// the Swift sidecar, "openlive-capture agent", a second long-lived process next to the
// per-stream captures, driven over the sidecar's socket protocol (internal/sidecar). The
// helper computes the menu (internal/tray) and decides what a click or a key does; the agent
// only shows and reports. Nothing here needs macOS, so the tests run against a fake agent.
package macagent

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/henriquefps/openlive/helper/internal/notify"
	"github.com/henriquefps/openlive/helper/internal/sidecar"
)

// startTimeout bounds the agent's hello.
var startTimeout = 10 * time.Second

// Agent is a running "openlive-capture agent".
type Agent struct {
	conn net.Conn
	cmd  *exec.Cmd
	log  *slog.Logger

	wmu sync.Mutex // serializes writes to conn
	// closed is set under wmu once Close started: no more writes.
	closed bool

	clicks        chan int32
	pressed       chan string
	notifications chan sidecar.Notifications
	bound         chan sidecar.HotkeysBound
	done          chan struct{}
	exited        chan struct{}
	stopOnce      sync.Once
	// ids names the notifications (sidecar.Notify.ID).
	ids atomic.Uint32
}

// Start runs bin ("openlive-capture", ideally from the app bundle) as the agent. The agent
// stops with ctx, Close or the helper's exit (the socket closes).
func Start(ctx context.Context, bin string, log *slog.Logger) (*Agent, error) {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	conn, cmd, stderr, err := sidecar.Spawn(bin, "agent", "--fd", "3")
	if err != nil {
		return nil, fmt.Errorf("start the menu bar agent: %w", err)
	}
	a := &Agent{
		conn: conn, cmd: cmd, log: log,
		clicks:        make(chan int32, 16),
		pressed:       make(chan string, 16),
		notifications: make(chan sidecar.Notifications, 4),
		bound:         make(chan sidecar.HotkeysBound, 1),
		done:          make(chan struct{}),
		exited:        make(chan struct{}),
	}
	go func() {
		_ = cmd.Wait()
		close(a.exited)
	}()
	go a.logStderr(stderr)
	if err := a.hello(); err != nil {
		a.Close()
		return nil, err
	}
	go a.readLoop()
	go func() {
		select {
		case <-ctx.Done():
			a.Close()
		case <-a.done:
		}
	}()
	return a, nil
}

func (a *Agent) logStderr(r io.ReadCloser) {
	defer func() { _ = r.Close() }()
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		a.log.Info("menu bar agent", "msg", strings.TrimPrefix(sc.Text(), "openlive-capture: "))
	}
}

func (a *Agent) hello() error {
	_ = a.conn.SetReadDeadline(time.Now().Add(startTimeout))
	defer func() { _ = a.conn.SetReadDeadline(time.Time{}) }()
	m, err := sidecar.Read(a.conn)
	if err != nil {
		return fmt.Errorf("the menu bar agent did not say hello: %w", err)
	}
	var hello sidecar.Hello
	if m.Type != sidecar.TypeHello || m.Decode(&hello) != nil {
		return fmt.Errorf("menu bar agent: expected hello, got message 0x%02x", byte(m.Type))
	}
	if hello.ProtocolVersion != sidecar.ProtocolVersion {
		return fmt.Errorf("menu bar agent %s speaks protocol %d, this helper %d: rebuild them together", hello.Version, hello.ProtocolVersion, sidecar.ProtocolVersion)
	}
	return nil
}

func (a *Agent) readLoop() {
	defer a.Close()
	for {
		m, err := sidecar.Read(a.conn)
		if err != nil {
			a.wmu.Lock()
			closing := a.closed
			a.wmu.Unlock()
			if !closing {
				a.log.Warn("the menu bar agent exited", "err", err)
			}
			return
		}
		switch m.Type {
		case sidecar.TypeMenuClick:
			var c sidecar.MenuClick
			if m.Decode(&c) == nil {
				a.deliver(func() bool { return trySend(a.clicks, c.ID) })
			}
		case sidecar.TypeHotkey:
			var h sidecar.Hotkey
			if m.Decode(&h) == nil {
				a.deliver(func() bool { return trySend(a.pressed, h.Action) })
			}
		case sidecar.TypeHotkeysBound:
			var b sidecar.HotkeysBound
			if m.Decode(&b) == nil {
				a.deliver(func() bool { return trySend(a.bound, b) })
			}
		case sidecar.TypeNotifications:
			var n sidecar.Notifications
			if m.Decode(&n) == nil {
				a.deliver(func() bool { return trySend(a.notifications, n) })
			}
		case sidecar.TypeError:
			var e sidecar.Error
			if m.Decode(&e) == nil {
				a.log.Warn("menu bar agent", "code", e.Code, "err", e.Message)
			}
		}
	}
}

// deliver drops what nobody reads: a click or key press is only worth it while someone acts on it.
func (a *Agent) deliver(send func() bool) {
	if !send() {
		a.log.Debug("menu bar agent: event dropped (nobody reading)")
	}
}

func trySend[T any](ch chan T, v T) bool {
	select {
	case ch <- v:
		return true
	default:
		return false
	}
}

func (a *Agent) write(t sidecar.Type, v any) error {
	a.wmu.Lock()
	defer a.wmu.Unlock()
	if a.closed {
		return ErrClosed
	}
	_ = a.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if v == nil {
		return sidecar.Write(a.conn, t, nil)
	}
	return sidecar.WriteJSON(a.conn, t, v)
}

// ErrClosed: the agent is gone.
var ErrClosed = errors.New("the menu bar agent is not running")

// SetMenu shows m: the icon, the tooltip and the menu.
func (a *Agent) SetMenu(m sidecar.Menu) error { return a.write(sidecar.TypeMenu, m) }

// Clicks are the menu items clicked, by id.
func (a *Agent) Clicks() <-chan int32 { return a.clicks }

// Notifications are the notification permission's states: the first once the agent knows
// it (after the person answered the system's prompt, the first time), then its changes.
func (a *Agent) Notifications() <-chan sidecar.Notifications { return a.notifications }

// Notify implements notify.Notifier through UserNotifications: a notification with
// ReplacesID replaces that one, as on Linux.
func (a *Agent) Notify(n notify.Notification) (uint32, error) {
	id := n.ReplacesID
	if id == 0 {
		id = a.ids.Add(1)
	}
	return id, a.write(sidecar.TypeNotify, sidecar.Notify{ID: id, Title: n.Summary, Body: n.Body, Critical: n.Critical, Transient: n.Transient})
}

// BindHotkeys replaces the global shortcuts with bindings and returns what the agent could
// register: a shortcut another app holds is a conflict.
func (a *Agent) BindHotkeys(ctx context.Context, bindings []sidecar.HotkeyBinding) ([]sidecar.HotkeyResult, error) {
	// A stale answer from an earlier call is not this one's.
	select {
	case <-a.bound:
	default:
	}
	if err := a.write(sidecar.TypeHotkeys, sidecar.Hotkeys{Bindings: bindings}); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	select {
	case b := <-a.bound:
		return b.Results, nil
	case <-a.done:
		return nil, ErrClosed
	case <-ctx.Done():
		return nil, fmt.Errorf("menu bar agent: no answer to the shortcuts: %w", ctx.Err())
	}
}

// Pressed are the actions of the global shortcuts pressed.
func (a *Agent) Pressed() <-chan string { return a.pressed }

// Done is closed once the agent is gone.
func (a *Agent) Done() <-chan struct{} { return a.done }

// Close asks the agent to quit, waits up to 2 s for it (then kills it) and closes Done.
func (a *Agent) Close() {
	a.stopOnce.Do(func() {
		_ = a.write(sidecar.TypeStop, nil)
		a.wmu.Lock()
		a.closed = true
		a.wmu.Unlock()
		select {
		case <-a.exited:
		case <-time.After(2 * time.Second):
			_ = a.cmd.Process.Kill()
			<-a.exited
		}
		_ = a.conn.Close()
		close(a.done)
	})
}
