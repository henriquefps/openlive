// SPDX-License-Identifier: AGPL-3.0-only

package hotkeys

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	portalDest     = "org.freedesktop.portal.Desktop"
	portalPath     = dbus.ObjectPath("/org/freedesktop/portal/desktop")
	shortcutsIface = "org.freedesktop.portal.GlobalShortcuts"
	requestIface   = "org.freedesktop.portal.Request"
	sessionIface   = "org.freedesktop.portal.Session"
	registryIface  = "org.freedesktop.host.portal.Registry"
)

// ErrUnavailable: the desktop has no GlobalShortcuts portal (GNOME before 48, wlroots
// compositors without a portal backend that implements it, X11 sessions without a portal).
var ErrUnavailable = errors.New("the desktop has no GlobalShortcuts portal")

// ErrCancelled: the person closed the desktop's shortcut dialog.
var ErrCancelled = errors.New("the shortcut dialog was cancelled")

// Bound is a shortcut as the desktop bound it.
type Bound struct {
	Action Action
	// Trigger is the desktop's description of the trigger ("Ctrl+Alt+Shift+H"), empty
	// when the person left it unassigned.
	Trigger string
}

// Session is a GlobalShortcuts portal session; Activated delivers the actions pressed.
type Session struct {
	conn      *dbus.Conn
	handle    dbus.ObjectPath
	activated chan Action
	Bound     []Bound

	closeOnce sync.Once
}

// Options for Bind.
type Options struct {
	// AppID registers the helper with the portal (host apps have no sandbox to name them),
	// so the desktop remembers its shortcuts. An installed .desktop file must have this
	// name: KDE refuses a session without an app id.
	AppID string
	// Describe is the human description of an action, shown in the desktop's settings.
	Describe func(Action) string
	// Timeout bounds the desktop's dialog (default 5 minutes).
	Timeout time.Duration
}

func token() string { return fmt.Sprintf("openlive%d", rand.Uint32()) }

// Bind opens a session and binds the shortcuts. The first time, KDE shows a dialog where
// the person accepts or changes the triggers; later runs bind silently. The returned
// session lives until Close or the end of ctx.
func Bind(ctx context.Context, bindings []Binding, opts Options) (*Session, error) {
	if opts.Timeout <= 0 {
		opts.Timeout = 5 * time.Minute
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("global shortcuts: session bus: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	obj := conn.Object(portalDest, portalPath)
	if opts.AppID != "" {
		// Must come before any other portal call on this connection; older portals lack it.
		// The portal looks the id up among the installed .desktop files, and may take a
		// moment to see one written just now.
		for attempt := 0; ; attempt++ {
			err := obj.CallWithContext(ctx, registryIface+".Register", 0, opts.AppID, map[string]dbus.Variant{}).Err
			if err == nil || attempt == 4 || !strings.Contains(err.Error(), "not found") {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	if _, err := obj.GetProperty(shortcutsIface + ".version"); err != nil {
		return nil, ErrUnavailable
	}
	res, err := request(ctx, conn, "CreateSession", 30*time.Second, map[string]dbus.Variant{
		"session_handle_token": dbus.MakeVariant(token()),
	})
	if err != nil {
		return nil, err
	}
	handle, _ := res["session_handle"].Value().(string)
	if handle == "" {
		if p, isPath := res["session_handle"].Value().(dbus.ObjectPath); isPath {
			handle = string(p)
		}
	}
	if handle == "" {
		return nil, errors.New("global shortcuts: CreateSession returned no session")
	}
	s := &Session{conn: conn, handle: dbus.ObjectPath(handle), activated: make(chan Action, 8)}
	if err := s.listen(); err != nil {
		return nil, err
	}

	type shortcut struct {
		ID    string
		Props map[string]dbus.Variant
	}
	var list []shortcut
	for _, b := range bindings {
		desc := string(b.Action)
		if opts.Describe != nil {
			desc = opts.Describe(b.Action)
		}
		list = append(list, shortcut{ID: string(b.Action), Props: map[string]dbus.Variant{
			"description":       dbus.MakeVariant(desc),
			"preferred_trigger": dbus.MakeVariant(b.Trigger),
		}})
	}
	res, err = request(ctx, conn, "BindShortcuts", opts.Timeout, s.handle, list, "", map[string]dbus.Variant{})
	if err != nil {
		s.Close()
		return nil, err
	}
	s.Bound = parseBound(res["shortcuts"])
	ok = true
	go func() {
		<-ctx.Done()
		s.Close()
	}()
	return s, nil
}

func parseBound(v dbus.Variant) []Bound {
	var raw [][]any
	if err := dbus.Store([]any{v.Value()}, &raw); err != nil {
		return nil
	}
	var out []Bound
	for _, sc := range raw {
		if len(sc) != 2 {
			continue
		}
		id, _ := sc[0].(string)
		props, _ := sc[1].(map[string]dbus.Variant)
		trigger, _ := props["trigger_description"].Value().(string)
		out = append(out, Bound{Action: Action(id), Trigger: trigger})
	}
	return out
}

// listen forwards the Activated signals of this session.
func (s *Session) listen() error {
	match := []dbus.MatchOption{dbus.WithMatchInterface(shortcutsIface), dbus.WithMatchMember("Activated")}
	if err := s.conn.AddMatchSignal(match...); err != nil {
		return fmt.Errorf("global shortcuts: %w", err)
	}
	signals := make(chan *dbus.Signal, 16)
	s.conn.Signal(signals)
	go func() {
		defer close(s.activated)
		for sig := range signals {
			if sig.Name != shortcutsIface+".Activated" || len(sig.Body) < 2 {
				continue
			}
			if h, _ := sig.Body[0].(dbus.ObjectPath); h != s.handle {
				continue
			}
			id, _ := sig.Body[1].(string)
			select {
			case s.activated <- Action(id):
			default:
				// A burst of presses: drop, the next one gets through.
			}
		}
	}()
	return nil
}

// Activated delivers each press; it closes when the session ends.
func (s *Session) Activated() <-chan Action { return s.activated }

// Close ends the session; the desktop unbinds the shortcuts until the next run.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		_ = s.conn.Object(portalDest, s.handle).Call(sessionIface+".Close", 0).Err
		_ = s.conn.Close()
	})
}

// request calls a portal method that returns a Request handle and waits for its Response
// (the same handshake as the ScreenCast portal in internal/portal).
func request(ctx context.Context, conn *dbus.Conn, method string, timeout time.Duration, args ...any) (map[string]dbus.Variant, error) {
	opts, _ := args[len(args)-1].(map[string]dbus.Variant)
	tok := token()
	opts["handle_token"] = dbus.MakeVariant(tok)
	names := conn.Names()
	if len(names) == 0 {
		return nil, errors.New("global shortcuts: no unique bus name")
	}
	sender := strings.ReplaceAll(strings.TrimPrefix(names[0], ":"), ".", "_")
	path := dbus.ObjectPath(fmt.Sprintf("%s/request/%s/%s", portalPath, sender, tok))

	match := []dbus.MatchOption{dbus.WithMatchObjectPath(path), dbus.WithMatchInterface(requestIface), dbus.WithMatchMember("Response")}
	if err := conn.AddMatchSignal(match...); err != nil {
		return nil, fmt.Errorf("global shortcuts: %s: %w", method, err)
	}
	defer func() { _ = conn.RemoveMatchSignal(match...) }()
	signals := make(chan *dbus.Signal, 4)
	conn.Signal(signals)
	defer conn.RemoveSignal(signals)

	var got dbus.ObjectPath
	if err := conn.Object(portalDest, portalPath).CallWithContext(ctx, shortcutsIface+"."+method, 0, args...).Store(&got); err != nil {
		return nil, fmt.Errorf("global shortcuts: %s: %w", method, err)
	}
	if got != path {
		return nil, fmt.Errorf("global shortcuts: %s: unexpected request path %s", method, got)
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
				return nil, fmt.Errorf("global shortcuts: %s failed (response %d)", method, code)
			}
		case <-deadline.C:
			_ = conn.Object(portalDest, path).Call(requestIface+".Close", 0).Err
			return nil, fmt.Errorf("global shortcuts: no answer to %s after %s", method, timeout)
		case <-ctx.Done():
			_ = conn.Object(portalDest, path).Call(requestIface+".Close", 0).Err
			return nil, ctx.Err()
		}
	}
}
