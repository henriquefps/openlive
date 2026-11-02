// SPDX-License-Identifier: AGPL-3.0-only

package compositor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	kwinDest      = "org.kde.KWin"
	kwinScripting = "org.kde.kwin.Scripting"
	kwinScript    = "org.kde.kwin.Script"
	// The helper exports this object on its own bus connection; the KWin script calls it.
	watchPath  = dbus.ObjectPath("/dev/hfps/openlive/KWinWatch")
	watchIface = "dev.hfps.openlive.KWinWatch"
)

// kwinScriptSource pushes a JSON snapshot to the helper on load and whenever a window is
// added, removed, minimized, restored, moved, resized or renamed, or the outputs change
// (a move changes the client geometry too, which the pointer pings follow). KWin
// scripts cannot answer a D-Bus call, so the script calls the helper instead (callDBus).
const kwinScriptSource = `
const dest = %q, path = %q, iface = %q;
function rect(g) { return g ? [Math.round(g.width), Math.round(g.height), Math.round(g.x), Math.round(g.y)] : [0, 0, 0, 0]; }
function snap() {
  const windows = [];
  for (const w of workspace.windowList()) {
    if (!w.normalWindow && !w.dialog) continue;
    const f = rect(w.frameGeometry), c = rect(w.clientGeometry), b = rect(w.bufferGeometry);
    windows.push({id: String(w.internalId), caption: w.caption, class: w.resourceClass, pid: w.pid,
      minimized: w.minimized, fw: f[0], fh: f[1], cw: c[0], ch: c[1], bw: b[0], bh: b[1],
      fx: f[2], fy: f[3], cx: c[2], cy: c[3], bx: b[2], by: b[3],
      scale: w.output ? w.output.devicePixelRatio : 1, output: w.output ? w.output.name : ""});
  }
  const outputs = [];
  for (const o of workspace.screens) {
    const g = o.geometry;
    outputs.push({name: o.name, x: g.x, y: g.y, w: g.width, h: g.height, scale: o.devicePixelRatio});
  }
  callDBus(dest, path, iface, "Update", JSON.stringify({windows: windows, outputs: outputs}));
}
function watch(w) {
  w.minimizedChanged.connect(snap);
  w.captionChanged.connect(snap);
  if (w.clientGeometryChanged) w.clientGeometryChanged.connect(snap);
  else w.frameGeometryChanged.connect(snap);
}
for (const w of workspace.windowList()) watch(w);
workspace.windowAdded.connect(function (w) { watch(w); snap(); });
workspace.windowRemoved.connect(snap);
workspace.screensChanged.connect(snap);
snap();
`

// KWin watches KWin through a short script loaded over D-Bus (Plasma 6 scripting API).
type KWin struct {
	conn   *dbus.Conn
	plugin string
	file   string

	mu      sync.Mutex
	last    Snapshot
	have    bool
	updates chan Snapshot
	ready   chan struct{}
	once    sync.Once
	closed  sync.Once
}

// kwinWatch is the exported D-Bus object.
type kwinWatch struct{ k *KWin }

// Update receives a snapshot from the script.
func (w kwinWatch) Update(raw string) *dbus.Error {
	var s Snapshot
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return dbus.MakeFailedError(err)
	}
	w.k.mu.Lock()
	w.k.last, w.k.have = s, true
	w.k.mu.Unlock()
	w.k.once.Do(func() { close(w.k.ready) })
	// Keep only the newest snapshot queued: consumers want the current state.
	select {
	case <-w.k.updates:
	default:
	}
	select {
	case w.k.updates <- s:
	default:
	}
	return nil
}

// defaultPlugin is the script name used for every helper start. A stable name lets a new
// helper unload the script a crashed one left behind; a random name per process leaked it.
const defaultPlugin = "openlive-helper-watch"

// answerTimeout is how long one attempt waits for the loaded script to push its first snapshot.
var answerTimeout = 2 * time.Second

// WatchKWin loads the watch script into KWin and waits for its first snapshot.
func WatchKWin(ctx context.Context) (*KWin, error) {
	return watchKWin(ctx, defaultPlugin)
}

// WatchKWinAs is WatchKWin under another script name, for a one-off command (debug ping)
// that must not unload the script of a helper streaming at the same time.
func WatchKWinAs(ctx context.Context, plugin string) (*KWin, error) {
	return watchKWin(ctx, plugin)
}

func watchKWin(ctx context.Context, plugin string) (*KWin, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("kwin: session bus: %w", err)
	}
	return watchKWinOn(ctx, conn, plugin)
}

// watchKWinOn takes ownership of conn.
func watchKWinOn(ctx context.Context, conn *dbus.Conn, plugin string) (*KWin, error) {
	var owner string
	if err := conn.BusObject().Call("org.freedesktop.DBus.GetNameOwner", 0, kwinDest).Store(&owner); err != nil {
		_ = conn.Close()
		return nil, ErrUnsupported
	}
	k := &KWin{
		conn:    conn,
		plugin:  plugin,
		updates: make(chan Snapshot, 1),
		ready:   make(chan struct{}),
	}
	if err := conn.Export(kwinWatch{k}, watchPath, watchIface); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("kwin: export: %w", err)
	}
	if err := k.startScript(ctx); err != nil {
		k.Close()
		return nil, err
	}
	return k, nil
}

// startScript clears any leftover script of the same name, loads ours and checks that it
// really runs. A crashed helper never unloads its script; KWin then keeps a stale
// /Scripting/Script<id> and can hand the same id to the next loadScript, so run() on that
// path may hit the dead object and the new script never starts. Each attempt therefore
// unloads first, runs the script, and if no snapshot arrives falls back to Scripting.start().
// A second attempt follows before giving up.
func (k *KWin) startScript(ctx context.Context) error {
	if err := k.writeSource(); err != nil {
		return err
	}
	var lastErr error
	for attempt := 1; attempt <= 2; attempt++ {
		k.unload()
		id, err := k.loadScript()
		if err != nil {
			lastErr = err
			continue
		}
		if k.runScript(id) == nil && k.waitReady(ctx) {
			return nil
		}
		if ctx.Err() != nil {
			break
		}
		// run() reached nothing useful: ask KWin to start every loaded script instead.
		if err := k.conn.Object(kwinDest, "/Scripting").Call(kwinScripting+".start", 0).Err; err == nil && k.waitReady(ctx) {
			return nil
		}
		if ctx.Err() != nil {
			break
		}
		lastErr = fmt.Errorf("script %q (id %d) loaded but never answered", k.plugin, id)
	}
	if ctx.Err() != nil {
		return fmt.Errorf("kwin: no answer from the watch script: %w", ctx.Err())
	}
	return fmt.Errorf("kwin: could not start the watch script (a stale script may be loaded; try `qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript %s`): %w", k.plugin, lastErr)
}

func (k *KWin) waitReady(ctx context.Context) bool {
	t := time.NewTimer(answerTimeout)
	defer t.Stop()
	select {
	case <-k.ready:
		return true
	case <-t.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func (k *KWin) writeSource() error {
	f, err := os.CreateTemp("", "openlive-kwin-*.js")
	if err != nil {
		return err
	}
	k.file = f.Name()
	src := fmt.Sprintf(kwinScriptSource, k.conn.Names()[0], string(watchPath), watchIface)
	if _, err := f.WriteString(src); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// unload removes a script of our name if one is loaded; a missing script is not an error.
func (k *KWin) unload() {
	_ = k.conn.Object(kwinDest, "/Scripting").Call(kwinScripting+".unloadScript", 0, k.plugin).Err
}

func (k *KWin) loadScript() (int32, error) {
	var id int32
	if err := k.conn.Object(kwinDest, "/Scripting").Call(kwinScripting+".loadScript", 0, k.file, k.plugin).Store(&id); err != nil {
		return 0, fmt.Errorf("kwin: loadScript: %w", err)
	}
	if id < 0 {
		return 0, fmt.Errorf("kwin: loadScript refused the script (%d)", id)
	}
	return id, nil
}

func (k *KWin) runScript(id int32) error {
	// Plasma 6 exposes loaded scripts at /Scripting/Script<id>; older builds at /<id>.
	for _, p := range []string{fmt.Sprintf("/Scripting/Script%d", id), fmt.Sprintf("/%d", id)} {
		if err := k.conn.Object(kwinDest, dbus.ObjectPath(p)).Call(kwinScript+".run", 0).Err; err == nil {
			return nil
		}
	}
	return fmt.Errorf("kwin: could not run the watch script")
}

// Snapshot returns the latest state.
func (k *KWin) Snapshot() Snapshot {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.last
}

// Updates delivers each new snapshot; when the reader is slow only the newest is kept.
func (k *KWin) Updates() <-chan Snapshot { return k.updates }

// Close unloads the script.
func (k *KWin) Close() {
	k.closed.Do(func() {
		k.unload()
		if k.file != "" {
			_ = os.Remove(k.file)
		}
		_ = k.conn.Close()
	})
}

// String names the watcher in logs.
func (k *KWin) String() string { return "KWin " + strings.TrimPrefix(k.plugin, "openlive-helper-") }
