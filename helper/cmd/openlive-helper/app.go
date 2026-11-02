// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/autostart"
	"github.com/henriquefps/openlive/helper/internal/i18n"
	"github.com/henriquefps/openlive/helper/internal/media"
	"github.com/henriquefps/openlive/helper/internal/notify"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// The macOS app (packaging/macos): Finder starts "Openlive Helper.app" with no
// arguments, and this is what it does. It pairs (the address in a dialog, the code in the
// browser) when nothing is paired yet, lets the sidecar ask for Screen Recording, writes the
// LaunchAgent with this bundle's binary and has launchd start "run" now. "run" itself, with
// the menu bar item, is always the LaunchAgent's process, so opening the app again while it
// runs changes nothing, and an update (another version in the same place) restarts it.

// EnvAppVersion is set in the LaunchAgent to the app's version, so the plist changes with
// every update and the app reloads the agent.
const EnvAppVersion = "OPENLIVE_HELPER_APP_VERSION"

// appBundle is the .app around exe when exe is the bundle's main executable
// (<app>/Contents/MacOS/<name>).
func appBundle(exe string) (string, bool) {
	macOS := filepath.Dir(exe)
	contents := filepath.Dir(macOS)
	app := filepath.Dir(contents)
	if filepath.Base(macOS) != "MacOS" || filepath.Base(contents) != "Contents" || !strings.HasSuffix(app, ".app") {
		return "", false
	}
	return app, true
}

// runFromDiskImage says whether the app runs where it cannot stay: on the mounted disk image,
// or from a randomized read-only copy (App Translocation, for a quarantined app opened where
// it was downloaded). A LaunchAgent pointing there would break at the next login.
func runFromDiskImage(app string) bool {
	return strings.HasPrefix(app, "/Volumes/") || strings.Contains(app, "/AppTranslocation/")
}

// appLocale is the locale for the dialogs and the agent: LANG when set, else macOS's
// AppleLocale (Finder and launchd start apps without LANG), as a POSIX locale.
func appLocale(getenv func(string) string, appleLocale func() string) string {
	for _, v := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if s := getenv(v); s != "" {
			return s
		}
	}
	l := strings.TrimSpace(appleLocale())
	if l == "" {
		return ""
	}
	// en_US@rg=brzzzz → en_US
	l, _, _ = strings.Cut(l, "@")
	return l + ".UTF-8"
}

func macAppleLocale() string {
	out, err := exec.Command("defaults", "read", "-g", "AppleLocale").Output()
	if err != nil {
		return ""
	}
	return string(out)
}

// appDialog is the AppleScript of a message with an OK button.
func appDialog(title, message string, critical bool) string {
	quote := func(s string) string { return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"` }
	icon := "note"
	if critical {
		icon = "caution"
	}
	return "activate\ndisplay dialog " + quote(message) + " with title " + quote(title) +
		` buttons {"OK"} default button "OK" with icon ` + icon
}

func showDialog(title, message string, critical bool) {
	_ = exec.Command("osascript", "-e", appDialog(title, message, critical)).Run()
}

// launchctlSteps are the launchctl calls that (re)load the agent at plist: a changed plist
// replaces the loaded job (bootout, then bootstrap, which starts it: RunAtLoad); an unchanged
// one only starts it if it is not running (kickstart without -k), and is bootstrapped when it
// was never loaded.
func launchctlSteps(uid int, plist string, changed bool) (first [][]string, fallback []string) {
	domain := fmt.Sprintf("gui/%d", uid)
	target := domain + "/" + autostart.LaunchAgentLabel
	bootstrap := []string{"bootstrap", domain, plist}
	if changed {
		return [][]string{{"bootout", target}, bootstrap}, nil
	}
	return [][]string{{"kickstart", target}}, bootstrap
}

func loadLaunchAgent(plist string, changed bool) error {
	steps, fallback := launchctlSteps(os.Getuid(), plist, changed)
	var err error
	for i, args := range steps {
		out, e := exec.Command("launchctl", args...).CombinedOutput()
		if changed && i == 0 {
			// bootout fails when nothing was loaded; launchd may also need a moment to let go.
			time.Sleep(500 * time.Millisecond)
			continue
		}
		if e != nil {
			err = fmt.Errorf("launchctl %s: %w: %s", args[0], e, strings.TrimSpace(string(out)))
		}
	}
	if err != nil && fallback != nil {
		out, e := exec.Command("launchctl", fallback...).CombinedOutput()
		if e != nil {
			return fmt.Errorf("launchctl %s: %w: %s", fallback[0], e, strings.TrimSpace(string(out)))
		}
		return nil
	}
	return err
}

// runApp is the app's start (see the top of this file).
func runApp(app string) error {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	locale := appLocale(os.Getenv, macAppleLocale)
	cat := i18n.Catalog{Lang: i18n.Detect("", func(k string) string {
		if k == "LANG" {
			return locale
		}
		return ""
	})}
	title := cat.T(i18n.AppTitle)
	if runFromDiskImage(app) {
		showDialog(title, cat.T(i18n.AppMove), false)
		return nil
	}
	err := setUpApp(log, cat, locale)
	if err != nil {
		log.Error("app start", "err", explain(err))
		showDialog(title, cat.T(i18n.AppFailed, explain(err)), true)
	}
	return err
}

func setUpApp(log *slog.Logger, cat i18n.Catalog, locale string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var c common
	firstRun := false
	if _, err := autostartEntry(&c); err != nil {
		// Not paired yet: pair with the default instance first.
		addr, err := askInstance(ctx, cat.T(i18n.PairTitle), cat.T(i18n.AppPairPrompt))
		if err != nil {
			return err
		}
		if addr == "" {
			return nil
		}
		if err := pairFromApp(ctx, &c, cat, addr); err != nil {
			return err
		}
		firstRun = true
	}

	// The sidecar's "list" asks for Screen Recording (macOS's prompt, once) when it is not
	// allowed yet; the grant belongs to the app, which "run" under launchd is too.
	if b, err := media.NewMacBackend(media.MacOptions{Log: log}); err == nil {
		lctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		if _, err := b.Sources(lctx); err != nil {
			log.Info("screen recording not allowed yet", "err", err)
		}
		cancel()
	}

	entry, err := autostartEntry(&c)
	if err != nil {
		return err
	}
	entry.Env = map[string]string{EnvAppVersion: version}
	if locale != "" {
		entry.Env["LANG"] = locale
	}
	dir, err := autostart.Dir()
	if err != nil {
		return err
	}
	plist := filepath.Join(dir, autostart.LaunchAgentLabel+".plist")
	before, _ := os.ReadFile(plist)
	if _, err := autostart.Enable(dir, entry); err != nil {
		return err
	}
	after, _ := os.ReadFile(plist)
	changed := !bytes.Equal(before, after)
	if err := loadLaunchAgent(plist, changed); err != nil {
		return err
	}
	log.Info("helper started by launchd", "plist", plist, "reloaded", changed)
	if firstRun {
		showDialog(cat.T(i18n.AppTitle), cat.T(i18n.AppReady, entry.Args[2]), false)
	}
	return nil
}

// pairFromApp pairs with addr as the default instance: the browser opens the confirmation
// page with the code filled in, and a notification repeats the code.
func pairFromApp(ctx context.Context, c *common, cat i18n.Catalog, addr string) error {
	client, err := api.NewClient(addr, "", userAgent())
	if err != nil {
		return err
	}
	instance := client.Base.String()
	notes, _ := notify.NewOSAScript()
	host, _ := os.Hostname()
	p := &api.Pairer{
		Client: client,
		Prompt: func(pp api.PairingPrompt) {
			if notes != nil {
				_, _ = notes.Notify(notify.Notification{Summary: cat.T(i18n.PairTitle), Body: cat.T(i18n.PairCode, pp.UserCode, pp.URL)})
			}
		},
		OpenBrowser: openBrowser,
	}
	req := protocol.DeviceCodeRequest{OS: osName(), Arch: protocol.DeviceArch(runtime.GOARCH), HelperVersion: version}
	if host != "" {
		req.Name = &host
	}
	tok, err := p.Pair(ctx, req)
	if err != nil {
		return fmt.Errorf("pairing with %s: %w", instance, err)
	}
	return storePairing(c, instance, tok, host, true)
}

// startAsApp runs the app's start when this is the macOS app's executable.
func startAsApp() error {
	if runtime.GOOS != "darwin" {
		return errNotApp
	}
	exe, err := os.Executable()
	if err != nil {
		return errNotApp
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	app, ok := appBundle(exe)
	if !ok {
		return errNotApp
	}
	return runApp(app)
}
