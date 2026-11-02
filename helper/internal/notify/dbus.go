// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"context"
	"fmt"

	"github.com/godbus/dbus/v5"
)

const (
	notifyDest  = "org.freedesktop.Notifications"
	notifyPath  = "/org/freedesktop/Notifications"
	notifyIface = "org.freedesktop.Notifications"
)

// DBus sends notifications to the desktop's notification server.
type DBus struct {
	conn *dbus.Conn
	// AppName is shown as the sender ("Openlive").
	AppName string
	// DesktopEntry names the .desktop file, so the desktop groups and themes the
	// notifications as the app's.
	DesktopEntry string
}

// NewDBus connects to the session bus and checks that a notification server answers
// (D-Bus may start one, like mako or dunst, on the first call; ctx bounds the wait).
func NewDBus(ctx context.Context, appName, desktopEntry string) (*DBus, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("notifications: session bus: %w", err)
	}
	var name, vendor, ver, spec string
	if err := conn.Object(notifyDest, notifyPath).CallWithContext(ctx, notifyIface+".GetServerInformation", 0).Store(&name, &vendor, &ver, &spec); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("notifications: no notification server: %w", err)
	}
	return &DBus{conn: conn, AppName: appName, DesktopEntry: desktopEntry}, nil
}

// Notify implements Notifier.
func (d *DBus) Notify(n Notification) (uint32, error) {
	hints := map[string]dbus.Variant{
		// The helper plays its own sounds (or none, when muted).
		"suppress-sound": dbus.MakeVariant(true),
		"urgency":        dbus.MakeVariant(byte(1)),
	}
	if n.Critical {
		hints["urgency"] = dbus.MakeVariant(byte(2))
	}
	if n.Transient {
		hints["transient"] = dbus.MakeVariant(true)
	}
	if d.DesktopEntry != "" {
		hints["desktop-entry"] = dbus.MakeVariant(d.DesktopEntry)
	}
	var id uint32
	err := d.conn.Object(notifyDest, notifyPath).Call(notifyIface+".Notify", 0,
		d.AppName, n.ReplacesID, n.Icon, n.Summary, n.Body, []string{}, hints, int32(-1)).Store(&id)
	return id, err
}

// Close disconnects from the bus.
func (d *DBus) Close() error { return d.conn.Close() }
