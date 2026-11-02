// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/autostart"
	"github.com/henriquefps/openlive/helper/internal/hotkeys"
	"github.com/henriquefps/openlive/helper/internal/i18n"
	"github.com/henriquefps/openlive/helper/internal/notify"
	"github.com/henriquefps/openlive/helper/internal/single"
	"github.com/henriquefps/openlive/helper/internal/store"
	"github.com/henriquefps/openlive/helper/internal/tray"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// appID names the helper to the desktop: the shortcut portal, the notifications and the
// autostart entry. Packaging installs dev.hfps.OpenliveHelper.desktop under this name.
const appID = "dev.hfps.OpenliveHelper"

// desktop is the helper's presence on the desktop while "run" is up: the
// tray icon and menu, the global shortcuts and the notifications. Each part is optional:
// without a tray host, a shortcut portal or a notification server the helper runs without
// it and says so in the log; the web controls it either way.
type desktop struct {
	ctl      *controller
	cat      i18n.Catalog
	log      *slog.Logger
	instance string
	flags    *common
	quit     context.CancelFunc
	tray     trayIcon
	notes    *notify.Center
	pairing  atomic.Bool

	// events runs every state change on one goroutine, in order.
	events chan func()
	// Owned by that goroutine.
	status    tray.Status
	net       notify.NetworkWatch
	roomNames map[string]string
	roomID    string
	source    string
}

// trayIcon is the tray icon: a StatusNotifierItem on Linux, the menu bar item on macOS.
type trayIcon interface{ Update(tray.Status) }

type desktopOptions struct {
	settings  store.Desktop
	instance  string
	flags     *common
	minimized bool
	quit      context.CancelFunc
	log       *slog.Logger
	// agent is the macOS agent's binary; empty finds the sidecar (tests set a fake).
	agent string
}

func startDesktop(ctx context.Context, ctl *controller, o desktopOptions) *desktop {
	d := &desktop{
		ctl: ctl, log: o.log, instance: o.instance, flags: o.flags, quit: o.quit,
		cat:       i18n.Catalog{Lang: i18n.Detect(o.settings.Language, nil)},
		events:    make(chan func(), 64),
		status:    tray.Status{Instance: o.instance, State: protocol.HelperStateIdle},
		roomNames: map[string]string{},
	}

	runDir := single.Dir()
	themeDir := filepath.Join(runDir, "icons")
	if err := tray.WriteTheme(themeDir); err != nil {
		d.log.Debug("tray icons", "err", err)
		themeDir = ""
	}
	d.notes = &notify.Center{
		Policy:  notify.NewPolicy(o.settings.Notifications),
		Catalog: d.cat,
		Player:  &notify.CommandPlayer{Dir: filepath.Join(runDir, "sounds")},
		Log:     d.log,
	}
	if themeDir != "" {
		d.notes.Icon = filepath.Join(themeDir, "hicolor", "scalable", "apps", tray.IconName(tray.IconLive)+".svg")
	}
	bindings, err := hotkeys.Parse(o.settings.Shortcuts)
	if err != nil {
		d.log.Warn("global shortcuts off: fix the config file", "err", err)
		bindings = nil
	}
	showIcon := o.settings.Tray == nil || *o.settings.Tray
	if runtime.GOOS == "darwin" {
		d.startMac(ctx, o.agent, showIcon, o.minimized, bindings)
		go d.loop(ctx)
		return d
	}

	// Connect in the background: starting a notification server can take a while, and
	// the hub must not wait for it.
	go func() {
		nctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		n, err := notify.NewDBus(nctx, "Openlive", appID)
		cancel()
		if err != nil {
			d.log.Info("no desktop notifications", "err", err)
			return
		}
		d.notes.SetNotifier(n)
		if !o.minimized {
			d.notes.Post(notify.Ready, notify.Args{})
		}
		<-ctx.Done()
		_ = n.Close()
	}()

	if showIcon {
		t, err := tray.Start(ctx, d.status, tray.Options{Catalog: d.cat, ThemeDir: themeDir, OnAction: d.act, Log: d.log})
		switch {
		case errors.Is(err, tray.ErrNoHost):
			d.tray = t
			d.log.Warn("no system tray on this desktop: running headless, the web still controls the helper (GNOME needs the AppIndicator extension); the icon shows if a tray starts later")
		case err != nil:
			d.log.Warn("no tray icon: running headless, the web still controls the helper", "err", err)
		default:
			d.tray = t
			d.log.Info("tray icon shown")
		}
	}

	// The portals know apps by their .desktop file (KDE's shortcuts refuse a helper
	// without one); a package installs it, a downloaded binary writes its own.
	if bin, err := os.Executable(); err == nil {
		entry := autostart.Entry{Binary: bin, Args: []string{"run"}, Name: "Openlive helper", Comment: "Stream to Openlive from the system tray"}
		if written, err := autostart.EnsureLauncher(entry, tray.AppIcon()); err != nil {
			d.log.Debug("application entry", "err", err)
		} else if written {
			d.log.Info("wrote the helper's application entry", "id", appID)
		}
	}
	if len(bindings) > 0 {
		go d.bindShortcuts(ctx, bindings)
	}
	// Events queued meanwhile (a tray click) wait in the channel.
	go d.loop(ctx)
	return d
}

func (d *desktop) loop(ctx context.Context) {
	for {
		select {
		case fn := <-d.events:
			fn()
		case <-ctx.Done():
			return
		}
	}
}

// enqueue runs fn on the desktop goroutine; it never blocks the caller (stats may drop).
func (d *desktop) enqueue(fn func()) {
	select {
	case d.events <- fn:
	default:
		d.log.Debug("desktop: event queue full, dropping one")
	}
}

func (d *desktop) bindShortcuts(ctx context.Context, bindings []hotkeys.Binding) {
	describe := func(a hotkeys.Action) string {
		switch a {
		case hotkeys.Curtain:
			return d.cat.T(i18n.ShortcutCurtain)
		case hotkeys.Pause:
			return d.cat.T(i18n.ShortcutPause)
		}
		return d.cat.T(i18n.ShortcutStop)
	}
	s, err := hotkeys.Bind(ctx, bindings, hotkeys.Options{AppID: appID, Describe: describe})
	switch {
	case errors.Is(err, hotkeys.ErrUnavailable):
		d.log.Info("no global shortcuts: the desktop has no GlobalShortcuts portal (KDE Plasma 6 and GNOME 48+ have one)")
		return
	case errors.Is(err, hotkeys.ErrCancelled):
		d.log.Info("global shortcuts not bound: the desktop's shortcut dialog was cancelled")
		return
	case err != nil:
		if ctx.Err() == nil {
			d.log.Warn("global shortcuts not bound", "err", err)
		}
		return
	}
	var bound []string
	for _, b := range s.Bound {
		trigger := b.Trigger
		if trigger == "" {
			trigger = "unassigned"
		}
		bound = append(bound, string(b.Action)+"="+trigger)
	}
	d.log.Info("global shortcuts bound", "shortcuts", strings.Join(bound, " "))
	for a := range s.Activated() {
		d.log.Debug("shortcut pressed", "action", a)
		d.enqueue(func() { d.shortcut(a) })
	}
}

// shortcut runs a pressed shortcut against the current state.
func (d *desktop) shortcut(a hotkeys.Action) {
	switch a {
	case hotkeys.Curtain, hotkeys.Pause:
		if act, ok := tray.Toggle(a == hotkeys.Curtain, d.status); ok {
			d.run(act)
		}
	case hotkeys.Stop:
		if d.streaming() {
			d.run(tray.Stop)
		}
	}
}

// act is a tray menu click.
func (d *desktop) act(a tray.Action) { d.enqueue(func() { d.run(a) }) }

// run executes an action on the desktop goroutine; slow ones go to their own goroutine.
func (d *desktop) run(a tray.Action) {
	ctx := context.Background()
	switch a {
	case tray.Pause:
		go d.ctl.pause(ctx, true, protocol.PauseReasonUser)
	case tray.CurtainOn:
		go d.ctl.pause(ctx, true, protocol.PauseReasonPrivacyCurtain)
	case tray.Resume, tray.CurtainOff:
		go d.ctl.pause(ctx, false, "")
	case tray.Stop:
		go d.ctl.stop(ctx)
	case tray.Open:
		url := strings.TrimSuffix(d.instance, "/") + "/"
		if d.streaming() && d.roomID != "" {
			url += "rooms/" + d.roomID
		}
		if err := openBrowser(url); err != nil {
			d.log.Warn("open the browser", "err", err)
		}
	case tray.Pair:
		if d.pairing.CompareAndSwap(false, true) {
			go func() {
				defer d.pairing.Store(false)
				d.pairAnother(ctx)
			}()
		}
	case tray.Quit:
		d.log.Info("quit from the tray")
		d.quit()
	}
}

func (d *desktop) streaming() bool {
	s := d.status.State
	return s == protocol.HelperStateLive || s == protocol.HelperStatePaused || s == protocol.HelperStateStarting
}

// online reports the hub socket going up or down.
func (d *desktop) online(up bool) {
	d.enqueue(func() {
		d.status.Online = up
		d.update()
	})
}

// streamStarted names the room and the source of the stream about to go live.
func (d *desktop) streamStarted(roomID, roomName, source string) {
	d.enqueue(func() {
		if roomName != "" {
			d.roomNames[roomID] = roomName
		}
		d.source = source
	})
}

// viewers is the live stream's viewer count.
func (d *desktop) viewers(used int) {
	d.enqueue(func() {
		if !d.streaming() {
			return
		}
		if used > d.status.Viewers {
			d.notes.Post(notify.ViewerJoined, notify.Args{Viewers: used})
		}
		d.status.Viewers = used
		d.update()
	})
}

// observe sees the controller's reports (controller.observe).
func (d *desktop) observe(p protocol.Payload) {
	switch p := p.(type) {
	case protocol.HelperStatusPayload:
		d.enqueue(func() { d.helperStatus(p) })
	case protocol.HelperStatsPayload:
		d.enqueue(func() {
			if d.status.State != protocol.HelperStateLive {
				return
			}
			if unstable, changed := d.net.Observe(p.TargetBitrateKbps, p.PacketLossPct); unstable && changed {
				d.notes.Post(notify.Unstable, notify.Args{})
			}
		})
	}
}

func (d *desktop) helperStatus(p protocol.HelperStatusPayload) {
	prev := d.status
	next := prev
	next.State, next.PauseReason, next.Room, next.Preset = p.State, "", "", ""
	d.roomID = ""
	if p.Stream != nil {
		d.roomID = p.Stream.RoomID
		next.Room = d.roomNames[p.Stream.RoomID]
		if next.Room == "" {
			next.Room = p.Stream.RoomID
		}
		next.Preset = string(p.Stream.Preset)
		if preset, err := presetOf(p.Stream.Preset); err == nil {
			next.Preset = preset.Name
		}
		if p.Stream.PauseReason != nil {
			next.PauseReason = *p.Stream.PauseReason
		}
	}
	wasLive := prev.State == protocol.HelperStateLive || prev.State == protocol.HelperStatePaused
	isLive := next.State == protocol.HelperStateLive || next.State == protocol.HelperStatePaused
	switch {
	case isLive && !wasLive:
		next.Viewers = 0
		d.net.Reset()
		d.notes.Post(notify.Started, notify.Args{Source: d.source, Room: next.Room})
	case next.State == protocol.HelperStateError && (wasLive || prev.State == protocol.HelperStateStopping):
		d.notes.Post(notify.Dropped, notify.Args{})
	case next.State == protocol.HelperStateIdle && (wasLive || prev.State == protocol.HelperStateStopping):
		d.notes.Post(notify.Stopped, notify.Args{})
	}
	curtainBefore := prev.State == protocol.HelperStatePaused && prev.PauseReason == protocol.PauseReasonPrivacyCurtain
	curtainNow := next.State == protocol.HelperStatePaused && next.PauseReason == protocol.PauseReasonPrivacyCurtain
	if wasLive && isLive && curtainBefore != curtainNow {
		d.notes.Post(notify.Curtain, notify.Args{On: curtainNow})
	}
	if !isLive {
		next.Viewers = 0
	}
	d.status = next
	d.update()
}

func (d *desktop) update() {
	if d.tray != nil {
		d.tray.Update(d.status)
	}
}

// pairAnother pairs this device with another instance from the tray: the instance address
// comes from a small dialog (kdialog on KDE, zenity elsewhere, AppleScript on macOS), the code goes to a
// notification and the browser, and the instance does not become the default.
func (d *desktop) pairAnother(ctx context.Context) {
	addr, err := askInstance(ctx, d.cat.T(i18n.PairTitle), d.cat.T(i18n.PairPrompt))
	if errors.Is(err, errNoDialog) {
		d.notes.Tell(d.cat.T(i18n.PairTitle), d.cat.T(i18n.PairManual), false)
		return
	}
	if err != nil || addr == "" {
		return
	}
	client, err := api.NewClient(addr, "", userAgent())
	if err != nil {
		d.notes.Tell(d.cat.T(i18n.PairFailed, err), "", true)
		return
	}
	instance := client.Base.String()
	host, _ := os.Hostname()
	p := &api.Pairer{
		Client: client,
		Prompt: func(pp api.PairingPrompt) {
			d.notes.Tell(d.cat.T(i18n.PairTitle), d.cat.T(i18n.PairCode, pp.UserCode, pp.URL), false)
		},
		OpenBrowser: openBrowser,
	}
	req := protocol.DeviceCodeRequest{OS: osName(), Arch: protocol.DeviceArch(runtime.GOARCH), HelperVersion: version}
	if host != "" {
		req.Name = &host
	}
	tok, err := p.Pair(ctx, req)
	if err == nil {
		err = storePairing(d.flags, instance, tok, host, false)
	}
	if err != nil {
		d.log.Warn("pairing from the tray", "instance", instance, "err", explain(err))
		d.notes.Tell(d.cat.T(i18n.PairFailed, explain(err)), "", true)
		return
	}
	d.log.Info("paired from the tray", "instance", instance)
	d.notes.Tell(d.cat.T(i18n.PairDone, instance), "openlive-helper run --instance "+instance, false)
}

var errNoDialog = errors.New("no dialog tool (kdialog, zenity or osascript)")

// askInstance asks for an instance address in a desktop dialog; "" when cancelled.
func askInstance(ctx context.Context, title, prompt string) (string, error) {
	var cmd *exec.Cmd
	if path, err := exec.LookPath("kdialog"); err == nil {
		cmd = exec.CommandContext(ctx, path, "--title", title, "--inputbox", prompt, "https://")
	} else if path, err := exec.LookPath("zenity"); err == nil {
		cmd = exec.CommandContext(ctx, path, "--entry", "--title", title, "--text", prompt, "--entry-text", "https://")
	} else if path, err := exec.LookPath("osascript"); err == nil && runtime.GOOS == "darwin" {
		cmd = exec.CommandContext(ctx, path, "-e", macInputDialog(title, prompt))
	} else {
		return "", errNoDialog
	}
	out, err := cmd.Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return "", nil // cancelled
	}
	if err != nil {
		return "", err
	}
	addr := strings.TrimSpace(string(out))
	if addr == "https://" {
		return "", nil
	}
	return addr, nil
}

// macInputDialog is the AppleScript of askInstance's dialog: it prints the text typed, and
// Cancel exits with an error (a cancel, as for the other tools).
func macInputDialog(title, prompt string) string {
	quote := func(s string) string { return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"` }
	return "activate\ntext returned of (display dialog " + quote(prompt) + ` default answer "https://" with title ` + quote(title) + ")"
}
