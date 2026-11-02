// SPDX-License-Identifier: AGPL-3.0-only

// Package portal opens xdg-desktop-portal ScreenCast sessions and
// keeps the portal's restore token, which rotates on every Start, together with what the
// person chose, so a restored session can be checked against that choice.
//
// The handshake: CreateSession → SelectSources
// (monitor or window, cursor embedded, persist_mode 2 with the saved restore token) →
// Start → OpenPipeWireRemote. Every request returns a Request object path and the result
// arrives later as a Response signal on that path, so the handle_token is chosen up front
// and the signal subscribed before the call.
package portal

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	portalDest   = "org.freedesktop.portal.Desktop"
	portalPath   = "/org/freedesktop/portal/desktop"
	screenCast   = "org.freedesktop.portal.ScreenCast"
	requestIface = "org.freedesktop.portal.Request"
	sessionIface = "org.freedesktop.portal.Session"

	cursorHidden   = 1
	cursorEmbedded = 2
	// persistUntilRevoked keeps the permission until the person revokes it: Start returns
	// a restore_token.
	persistUntilRevoked = 2
)

// Kind is what a ScreenCast session captures. The values are the portal's source types.
type Kind uint32

const (
	KindMonitor Kind = 1
	KindWindow  Kind = 2
)

// String is the CLI and record name of the kind.
func (k Kind) String() string {
	switch k {
	case KindMonitor:
		return "monitor"
	case KindWindow:
		return "window"
	}
	return fmt.Sprintf("kind(%d)", uint32(k))
}

// ParseKind parses "monitor" or "window".
func ParseKind(s string) (Kind, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "monitor", "screen":
		return KindMonitor, nil
	case "window":
		return KindWindow, nil
	}
	return 0, fmt.Errorf("unknown source %q (want monitor or window)", s)
}

// Source is what is being shared, for the UI: "always show what is being
// shared".
type Source struct {
	Kind  Kind
	Label string
	// Width and Height are in pixels; zero when unknown (the portal reports 0x0 for a
	// restored window until the first frame).
	Width, Height int
}

// Options configure one session.
type Options struct {
	Kind Kind
	// RestoreToken from a previous Start; empty shows the dialog.
	RestoreToken string
	HideCursor   bool
	// StartTimeout bounds the wait for the person to answer the dialog.
	StartTimeout time.Duration
}

// Stream is one PipeWire stream of a started session.
type Stream struct {
	NodeID uint32
	// Serial is the node's object.serial: what pipewiresrc's target-object expects (node
	// ids are reused, serials are not).
	Serial uint64
	Kind   Kind
	// Width/Height and X/Y as the portal reports them (logical pixels on KDE); zero when
	// it reports none.
	Width, Height int
	X, Y          int
	HasPosition   bool
	// ID is the portal's own stream id, when it sends one.
	ID string
}

// Session is a started ScreenCast session.
type Session struct {
	conn    *dbus.Conn
	handle  dbus.ObjectPath
	Streams []Stream
	// RestoreToken is the token for the next session. It rotates on every Start: the one
	// that was sent is no longer valid.
	RestoreToken string
	// Restored is true when a restore token was sent and Start returned before a person
	// could have answered a dialog (the portal does not say whether it showed one).
	Restored  bool
	StartTook time.Duration

	closed    chan struct{}
	closeOnce sync.Once
}

// restoredBelow is how fast a Start must answer to count as restored without a dialog.
// Phase 0 P4/P7 measured 4–13 ms with a token; a person needs far more than this.
const restoredBelow = 500 * time.Millisecond

// ErrCancelled is returned when the person closes the portal dialog.
var ErrCancelled = errors.New("screen sharing was cancelled in the system dialog")

func handleToken() string { return fmt.Sprintf("openlive%d", rand.Uint32()) }

// Open runs the whole portal handshake. It needs a session bus that passes file
// descriptors (any Wayland desktop with xdg-desktop-portal).
func Open(ctx context.Context, opts Options) (*Session, error) {
	if opts.Kind != KindMonitor && opts.Kind != KindWindow {
		return nil, fmt.Errorf("portal: unknown source kind %d", opts.Kind)
	}
	if opts.StartTimeout <= 0 {
		opts.StartTimeout = 5 * time.Minute
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("portal: session bus: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	if !conn.SupportsUnixFDs() {
		return nil, errors.New("portal: the session bus does not pass file descriptors")
	}
	obj := conn.Object(portalDest, portalPath)
	if v, err := obj.GetProperty(screenCast + ".AvailableSourceTypes"); err == nil {
		if types, _ := v.Value().(uint32); types&uint32(opts.Kind) == 0 {
			return nil, fmt.Errorf("portal: this desktop cannot share a %s (available types %d)", opts.Kind, types)
		}
	} else {
		return nil, fmt.Errorf("portal: no ScreenCast portal on this desktop: %w", err)
	}

	res, err := request(ctx, conn, "CreateSession", 30*time.Second, map[string]dbus.Variant{
		"session_handle_token": dbus.MakeVariant(handleToken()),
	})
	if err != nil {
		return nil, err
	}
	handle, _ := res["session_handle"].Value().(string)
	s := &Session{conn: conn, handle: dbus.ObjectPath(handle), closed: make(chan struct{})}
	if err := s.watchClosed(); err != nil {
		return nil, err
	}

	cursor := uint32(cursorEmbedded)
	if opts.HideCursor {
		cursor = cursorHidden
	}
	sel := map[string]dbus.Variant{
		"types":        dbus.MakeVariant(uint32(opts.Kind)),
		"multiple":     dbus.MakeVariant(false),
		"cursor_mode":  dbus.MakeVariant(cursor),
		"persist_mode": dbus.MakeVariant(uint32(persistUntilRevoked)),
	}
	if opts.RestoreToken != "" {
		sel["restore_token"] = dbus.MakeVariant(opts.RestoreToken)
	}
	if _, err := request(ctx, conn, "SelectSources", 30*time.Second, s.handle, sel); err != nil {
		s.Close()
		return nil, err
	}

	started := time.Now()
	res, err = request(ctx, conn, "Start", opts.StartTimeout, s.handle, "", map[string]dbus.Variant{})
	if err != nil {
		s.Close()
		return nil, err
	}
	s.StartTook = time.Since(started)
	s.Restored = opts.RestoreToken != "" && s.StartTook < restoredBelow
	if v, ok := res["restore_token"]; ok {
		s.RestoreToken, _ = v.Value().(string)
	}
	if s.Streams, err = parseStreams(res["streams"]); err != nil {
		s.Close()
		return nil, err
	}
	for i := range s.Streams {
		if s.Streams[i].Kind == 0 {
			s.Streams[i].Kind = opts.Kind
		}
	}
	ok = true
	return s, nil
}

// parseStreams decodes the a(ua{sv}) streams of a Start response.
func parseStreams(v dbus.Variant) ([]Stream, error) {
	var raw [][]any
	if err := dbus.Store([]any{v.Value()}, &raw); err != nil {
		return nil, fmt.Errorf("portal: streams: %w", err)
	}
	var out []Stream
	for _, st := range raw {
		if len(st) != 2 {
			continue
		}
		node, _ := st[0].(uint32)
		props, _ := st[1].(map[string]dbus.Variant)
		out = append(out, streamFromProps(node, props))
	}
	if len(out) == 0 {
		return nil, errors.New("portal: Start returned no streams")
	}
	return out, nil
}

func streamFromProps(node uint32, props map[string]dbus.Variant) Stream {
	s := Stream{NodeID: node}
	// size and position are structs (ii), which godbus decodes as []any.
	if v, ok := props["size"].Value().([]any); ok && len(v) == 2 {
		w, _ := v[0].(int32)
		h, _ := v[1].(int32)
		s.Width, s.Height = int(w), int(h)
	}
	if v, ok := props["position"].Value().([]any); ok && len(v) == 2 {
		x, _ := v[0].(int32)
		y, _ := v[1].(int32)
		s.X, s.Y, s.HasPosition = int(x), int(y), true
	}
	if v, ok := props["pipewire-serial"]; ok {
		s.Serial, _ = v.Value().(uint64)
	}
	if v, ok := props["source_type"]; ok {
		t, _ := v.Value().(uint32)
		s.Kind = Kind(t)
	}
	if v, ok := props["id"]; ok {
		s.ID, _ = v.Value().(string)
	}
	return s
}

// request calls a portal method that returns a Request handle and waits for its Response.
// The options dict is always the last argument; handle_token is added to it so the
// request path is known before the call returns (no race with the Response).
func request(ctx context.Context, conn *dbus.Conn, method string, timeout time.Duration, args ...any) (map[string]dbus.Variant, error) {
	opts, _ := args[len(args)-1].(map[string]dbus.Variant)
	tok := handleToken()
	opts["handle_token"] = dbus.MakeVariant(tok)
	names := conn.Names()
	if len(names) == 0 {
		return nil, errors.New("portal: no unique bus name")
	}
	sender := strings.ReplaceAll(strings.TrimPrefix(names[0], ":"), ".", "_")
	path := dbus.ObjectPath(fmt.Sprintf("%s/request/%s/%s", portalPath, sender, tok))

	match := []dbus.MatchOption{dbus.WithMatchObjectPath(path), dbus.WithMatchInterface(requestIface), dbus.WithMatchMember("Response")}
	if err := conn.AddMatchSignal(match...); err != nil {
		return nil, fmt.Errorf("portal: %s: %w", method, err)
	}
	defer func() { _ = conn.RemoveMatchSignal(match...) }()
	signals := make(chan *dbus.Signal, 4)
	conn.Signal(signals)
	defer conn.RemoveSignal(signals)

	var got dbus.ObjectPath
	if err := conn.Object(portalDest, portalPath).CallWithContext(ctx, screenCast+"."+method, 0, args...).Store(&got); err != nil {
		return nil, fmt.Errorf("portal: %s: %w", method, err)
	}
	if got != path {
		return nil, fmt.Errorf("portal: %s: unexpected request path %s", method, got)
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case sig := <-signals:
			if sig.Path != path || sig.Name != requestIface+".Response" || len(sig.Body) < 2 {
				continue
			}
			code, _ := sig.Body[0].(uint32)
			results, _ := sig.Body[1].(map[string]dbus.Variant)
			switch code {
			case 0:
				return results, nil
			case 1:
				return nil, ErrCancelled
			default:
				return nil, fmt.Errorf("portal: %s failed (response %d)", method, code)
			}
		case <-deadline.C:
			// Close the dialog rather than leave it on screen.
			_ = conn.Object(portalDest, path).Call(requestIface+".Close", 0).Err
			return nil, fmt.Errorf("portal: no answer to %s after %s", method, timeout)
		case <-ctx.Done():
			_ = conn.Object(portalDest, path).Call(requestIface+".Close", 0).Err
			return nil, ctx.Err()
		}
	}
}

// watchClosed closes Closed() when the portal ends the session (the person stopped
// sharing from the desktop's own indicator, or the source went away).
func (s *Session) watchClosed() error {
	match := []dbus.MatchOption{dbus.WithMatchObjectPath(s.handle), dbus.WithMatchInterface(sessionIface), dbus.WithMatchMember("Closed")}
	if err := s.conn.AddMatchSignal(match...); err != nil {
		return fmt.Errorf("portal: watch session: %w", err)
	}
	signals := make(chan *dbus.Signal, 4)
	s.conn.Signal(signals)
	go func() {
		for sig := range signals {
			if sig.Path == s.handle && sig.Name == sessionIface+".Closed" {
				s.markClosed()
				return
			}
		}
	}()
	return nil
}

func (s *Session) markClosed() { s.closeOnce.Do(func() { close(s.closed) }) }

// Closed is closed when the session ends, from either side.
func (s *Session) Closed() <-chan struct{} { return s.closed }

// OpenPipeWireRemote returns a new connection to the PipeWire remote that only sees this
// session's streams. pipewiresrc takes ownership of the descriptor it is given (and closes
// it), so call this once per source start.
func (s *Session) OpenPipeWireRemote() (*os.File, error) {
	var fd dbus.UnixFD
	if err := s.conn.Object(portalDest, portalPath).Call(screenCast+".OpenPipeWireRemote", 0, s.handle, map[string]dbus.Variant{}).Store(&fd); err != nil {
		return nil, fmt.Errorf("portal: OpenPipeWireRemote: %w", err)
	}
	return os.NewFile(uintptr(fd), "pipewire-remote"), nil
}

// Close ends the session and drops the bus connection.
func (s *Session) Close() {
	if s == nil || s.conn == nil {
		return
	}
	_ = s.conn.Object(portalDest, s.handle).Call(sessionIface+".Close", 0).Err
	_ = s.conn.Close()
	s.markClosed()
}
