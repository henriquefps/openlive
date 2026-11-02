// SPDX-License-Identifier: AGPL-3.0-only

package tray

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
	"github.com/godbus/dbus/v5/prop"

	"github.com/henriquefps/openlive/helper/internal/i18n"
)

const (
	itemIface    = "org.kde.StatusNotifierItem"
	itemPath     = dbus.ObjectPath("/StatusNotifierItem")
	menuIface    = "com.canonical.dbusmenu"
	menuPath     = dbus.ObjectPath("/MenuBar")
	watcherName  = "org.kde.StatusNotifierWatcher"
	watcherPath  = dbus.ObjectPath("/StatusNotifierWatcher")
	watcherIface = "org.kde.StatusNotifierWatcher"
)

// ErrNoHost: no tray host (StatusNotifierWatcher) is running: GNOME without the
// AppIndicator extension, or a compositor without a panel. The helper runs headless and
// registers if a host shows up later.
var ErrNoHost = errors.New("no system tray (StatusNotifierWatcher) on this desktop")

// Options for Start.
type Options struct {
	Catalog i18n.Catalog
	// ThemeDir holds the SVG icons (WriteTheme); empty uses the pixmaps only.
	ThemeDir string
	// OnAction runs a menu click; it must not block.
	OnAction func(Action)
	Log      *slog.Logger
}

// Tray is the helper's StatusNotifierItem and its DBusMenu.
type Tray struct {
	opts  Options
	conn  *dbus.Conn
	name  string
	props *prop.Properties

	mu       sync.Mutex
	status   Status
	revision uint32
	hosted   bool
}

// Start exports the tray item on the session bus and registers it with the tray host.
// Without a host it still returns the Tray with ErrNoHost: it registers once one appears.
func Start(ctx context.Context, initial Status, opts Options) (*Tray, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("tray: session bus: %w", err)
	}
	t := &Tray{opts: opts, conn: conn, status: initial, revision: 1}
	t.name = fmt.Sprintf("org.kde.StatusNotifierItem-%d-1", os.Getpid())
	if err := t.export(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if reply, err := conn.RequestName(t.name, dbus.NameFlagDoNotQueue); err != nil || reply != dbus.RequestNameReplyPrimaryOwner {
		_ = conn.Close()
		return nil, fmt.Errorf("tray: bus name %s: %v (reply %d)", t.name, err, reply)
	}
	if err := t.watchHost(ctx); err != nil {
		_ = conn.Close()
		return nil, err
	}
	go func() {
		<-ctx.Done()
		t.Close()
	}()
	if err := t.register(); err != nil {
		return t, err
	}
	return t, nil
}

func (t *Tray) export() error {
	icon := IconFor(t.status)
	themePath, iconName := "", ""
	if t.opts.ThemeDir != "" {
		themePath, iconName = t.opts.ThemeDir, IconName(icon)
	}
	none := []pixmap{}
	item := map[string]*prop.Prop{
		"Category":            constProp("ApplicationStatus"),
		"Id":                  constProp("openlive-helper"),
		"Title":               {Value: t.opts.Catalog.T(i18n.TooltipTitle), Emit: prop.EmitFalse},
		"Status":              {Value: "Active", Emit: prop.EmitFalse},
		"WindowId":            constProp(int32(0)),
		"IconThemePath":       constProp(themePath),
		"IconName":            {Value: iconName, Emit: prop.EmitFalse},
		"IconPixmap":          {Value: pixmaps(icon), Emit: prop.EmitFalse},
		"OverlayIconName":     constProp(""),
		"OverlayIconPixmap":   constProp(none),
		"AttentionIconName":   constProp(""),
		"AttentionIconPixmap": constProp(none),
		"AttentionMovieName":  constProp(""),
		"ToolTip":             {Value: t.tooltip(t.status), Emit: prop.EmitFalse},
		"ItemIsMenu":          constProp(true),
		"Menu":                constProp(menuPath),
	}
	menu := map[string]*prop.Prop{
		"Version":       constProp(uint32(3)),
		"TextDirection": constProp("ltr"),
		"Status":        constProp("normal"),
		"IconThemePath": constProp([]string{}),
	}
	var err error
	if t.props, err = prop.Export(t.conn, itemPath, prop.Map{itemIface: item}); err != nil {
		return fmt.Errorf("tray: %w", err)
	}
	menuProps, err := prop.Export(t.conn, menuPath, prop.Map{menuIface: menu})
	if err != nil {
		return fmt.Errorf("tray: %w", err)
	}
	if err := t.conn.Export((*itemMethods)(t), itemPath, itemIface); err != nil {
		return fmt.Errorf("tray: %w", err)
	}
	if err := t.conn.Export((*menuMethods)(t), menuPath, menuIface); err != nil {
		return fmt.Errorf("tray: %w", err)
	}
	itemNode := &introspect.Node{Name: string(itemPath), Interfaces: []introspect.Interface{
		introspect.IntrospectData, prop.IntrospectData,
		{Name: itemIface, Methods: introspect.Methods((*itemMethods)(t)), Properties: t.props.Introspection(itemIface),
			Signals: []introspect.Signal{{Name: "NewIcon"}, {Name: "NewToolTip"}, {Name: "NewTitle"}, {Name: "NewStatus", Args: []introspect.Arg{{Name: "status", Type: "s"}}}}},
	}}
	menuNode := &introspect.Node{Name: string(menuPath), Interfaces: []introspect.Interface{
		introspect.IntrospectData, prop.IntrospectData,
		{Name: menuIface, Methods: introspect.Methods((*menuMethods)(t)), Properties: menuProps.Introspection(menuIface),
			Signals: []introspect.Signal{{Name: "LayoutUpdated", Args: []introspect.Arg{{Name: "revision", Type: "u"}, {Name: "parent", Type: "i"}}}}},
	}}
	if err := t.conn.Export(introspect.NewIntrospectable(itemNode), itemPath, "org.freedesktop.DBus.Introspectable"); err != nil {
		return err
	}
	return t.conn.Export(introspect.NewIntrospectable(menuNode), menuPath, "org.freedesktop.DBus.Introspectable")
}

func constProp(v any) *prop.Prop { return &prop.Prop{Value: v, Emit: prop.EmitConst} }

// tooltip is the SNI ToolTip: (icon name, icon pixmaps, title, text).
func (t *Tray) tooltip(s Status) any {
	text := ""
	for i, d := range Details(s, t.opts.Catalog) {
		if i > 0 {
			text += "\n"
		}
		text += d
	}
	return struct {
		Icon    string
		Pixmaps []pixmap
		Title   string
		Text    string
	}{"", []pixmap{}, t.opts.Catalog.T(i18n.TooltipTitle) + ": " + StatusLine(s, t.opts.Catalog), text}
}

// register tells the tray host about the item.
func (t *Tray) register() error {
	err := t.conn.Object(watcherName, watcherPath).Call(watcherIface+".RegisterStatusNotifierItem", 0, t.name).Err
	t.mu.Lock()
	t.hosted = err == nil
	t.mu.Unlock()
	if err != nil {
		var de dbus.Error
		if errors.As(err, &de) && de.Name == "org.freedesktop.DBus.Error.ServiceUnknown" {
			return ErrNoHost
		}
		return fmt.Errorf("%w: %v", ErrNoHost, err)
	}
	return nil
}

// watchHost registers again whenever a tray host (re)starts: a Plasma restart, or the
// AppIndicator extension switched on after the helper started.
func (t *Tray) watchHost(ctx context.Context) error {
	match := []dbus.MatchOption{dbus.WithMatchInterface("org.freedesktop.DBus"), dbus.WithMatchMember("NameOwnerChanged"), dbus.WithMatchArg(0, watcherName)}
	if err := t.conn.AddMatchSignal(match...); err != nil {
		return fmt.Errorf("tray: %w", err)
	}
	signals := make(chan *dbus.Signal, 4)
	t.conn.Signal(signals)
	go func() {
		for {
			select {
			case sig, ok := <-signals:
				if !ok {
					return
				}
				if sig.Name != "org.freedesktop.DBus.NameOwnerChanged" || len(sig.Body) < 3 {
					continue
				}
				if owner, _ := sig.Body[2].(string); owner == "" {
					t.mu.Lock()
					t.hosted = false
					t.mu.Unlock()
					t.logInfo("the system tray went away; running without a tray icon")
					continue
				}
				if err := t.register(); err != nil {
					t.logInfo("tray host appeared but registration failed", "err", err)
				} else {
					t.logInfo("tray icon shown")
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return nil
}

// Hosted says whether a tray host shows the item.
func (t *Tray) Hosted() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.hosted
}

// Update shows a new status: icon, tooltip and menu.
func (t *Tray) Update(s Status) {
	t.mu.Lock()
	old := t.status
	if old == s {
		t.mu.Unlock()
		return
	}
	t.status = s
	t.revision++
	rev := t.revision
	t.mu.Unlock()
	if IconFor(old) != IconFor(s) {
		icon := IconFor(s)
		if t.opts.ThemeDir != "" {
			t.props.SetMust(itemIface, "IconName", IconName(icon))
		}
		t.props.SetMust(itemIface, "IconPixmap", pixmaps(icon))
		t.emit(itemPath, itemIface+".NewIcon")
	}
	t.props.SetMust(itemIface, "ToolTip", t.tooltip(s))
	t.emit(itemPath, itemIface+".NewToolTip")
	t.emit(menuPath, menuIface+".LayoutUpdated", rev, int32(0))
}

func (t *Tray) emit(path dbus.ObjectPath, name string, args ...any) {
	if err := t.conn.Emit(path, name, args...); err != nil {
		t.logDebug("tray signal", "signal", name, "err", err)
	}
}

// Close removes the item from the tray.
func (t *Tray) Close() { _ = t.conn.Close() }

func (t *Tray) current() (Status, uint32) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.status, t.revision
}

func (t *Tray) logInfo(msg string, args ...any) {
	if t.opts.Log != nil {
		t.opts.Log.Info(msg, args...)
	}
}

func (t *Tray) logDebug(msg string, args ...any) {
	if t.opts.Log != nil {
		t.opts.Log.Debug(msg, args...)
	}
}

// itemMethods are the StatusNotifierItem methods. ItemIsMenu is true, so hosts open the
// menu on any click; Activate is there for hosts that call it anyway.
type itemMethods Tray

func (m *itemMethods) ContextMenu(int32, int32) *dbus.Error       { return nil }
func (m *itemMethods) SecondaryActivate(int32, int32) *dbus.Error { return nil }
func (m *itemMethods) Scroll(int32, string) *dbus.Error           { return nil }
func (m *itemMethods) Activate(int32, int32) *dbus.Error {
	if m.opts.OnAction != nil {
		m.opts.OnAction(Open)
	}
	return nil
}

// menuMethods implement com.canonical.dbusmenu over Menu.
type menuMethods Tray

// layout is a DBusMenu node: (id, properties, children).
type layout struct {
	ID       int32
	Props    map[string]dbus.Variant
	Children []dbus.Variant
}

func itemProps(it Item) map[string]dbus.Variant {
	if it.Separator {
		return map[string]dbus.Variant{"type": dbus.MakeVariant("separator")}
	}
	p := map[string]dbus.Variant{
		"label":   dbus.MakeVariant(it.Label),
		"enabled": dbus.MakeVariant(it.Enabled),
	}
	if it.Checked != nil {
		state := int32(0)
		if *it.Checked {
			state = 1
		}
		p["toggle-type"] = dbus.MakeVariant("checkmark")
		p["toggle-state"] = dbus.MakeVariant(state)
	}
	return p
}

func (m *menuMethods) items() ([]Item, uint32) {
	s, rev := (*Tray)(m).current()
	return Menu(s, m.opts.Catalog), rev
}

func (m *menuMethods) GetLayout(parent int32, _ int32, _ []string) (uint32, layout, *dbus.Error) {
	items, rev := m.items()
	root := layout{ID: 0, Props: map[string]dbus.Variant{"children-display": dbus.MakeVariant("submenu")}, Children: []dbus.Variant{}}
	if parent != 0 {
		for _, it := range items {
			if it.ID == parent {
				return rev, layout{ID: it.ID, Props: itemProps(it), Children: []dbus.Variant{}}, nil
			}
		}
		return rev, root, dbus.MakeFailedError(fmt.Errorf("no menu item %d", parent))
	}
	for _, it := range items {
		root.Children = append(root.Children, dbus.MakeVariant(layout{ID: it.ID, Props: itemProps(it), Children: []dbus.Variant{}}))
	}
	return rev, root, nil
}

type groupProps struct {
	ID    int32
	Props map[string]dbus.Variant
}

func (m *menuMethods) GetGroupProperties(ids []int32, _ []string) ([]groupProps, *dbus.Error) {
	items, _ := m.items()
	var out []groupProps
	for _, it := range items {
		if len(ids) == 0 || containsID(ids, it.ID) {
			out = append(out, groupProps{ID: it.ID, Props: itemProps(it)})
		}
	}
	return out, nil
}

func (m *menuMethods) GetProperty(id int32, name string) (dbus.Variant, *dbus.Error) {
	items, _ := m.items()
	for _, it := range items {
		if it.ID == id {
			if v, ok := itemProps(it)[name]; ok {
				return v, nil
			}
		}
	}
	return dbus.MakeVariant(""), dbus.MakeFailedError(fmt.Errorf("no property %s on item %d", name, id))
}

func (m *menuMethods) Event(id int32, event string, _ dbus.Variant, _ uint32) *dbus.Error {
	if event != "clicked" {
		return nil
	}
	s, _ := (*Tray)(m).current()
	if a, ok := ActionOf(id, s, m.opts.Catalog); ok && m.opts.OnAction != nil {
		m.opts.OnAction(a)
	}
	return nil
}

type menuEvent struct {
	ID        int32
	Event     string
	Data      dbus.Variant
	Timestamp uint32
}

func (m *menuMethods) EventGroup(events []menuEvent) ([]int32, *dbus.Error) {
	for _, e := range events {
		_ = m.Event(e.ID, e.Event, e.Data, e.Timestamp)
	}
	return []int32{}, nil
}

func (m *menuMethods) AboutToShow(int32) (bool, *dbus.Error) { return false, nil }

func (m *menuMethods) AboutToShowGroup([]int32) ([]int32, []int32, *dbus.Error) {
	return []int32{}, []int32{}, nil
}

func containsID(ids []int32, id int32) bool {
	for _, i := range ids {
		if i == id {
			return true
		}
	}
	return false
}
