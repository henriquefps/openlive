// SPDX-License-Identifier: AGPL-3.0-only

package autostart

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDesktopContent(t *testing.T) {
	e := Entry{
		Binary:  "/home/me/.local/bin/openlive-helper",
		Args:    []string{"run", "--instance", "https://openlive.example", "--minimized"},
		Name:    "Openlive helper",
		Comment: "Stream to Openlive\nfrom the tray",
	}
	want := `[Desktop Entry]
Type=Application
Name=Openlive helper
Comment=Stream to Openlive from the tray
Exec=/home/me/.local/bin/openlive-helper run --instance https://openlive.example --minimized
Icon=dev.hfps.OpenliveHelper
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-KDE-autostart-phase=2
`
	if got := e.Desktop(); got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestQuote(t *testing.T) {
	cases := map[string]string{
		"plain":              "plain",
		"/a b/openlive":      `"/a b/openlive"`,
		"":                   `""`,
		"100%":               "100%%",
		`say "hi" $HOME`:     `"say \\"hi\\" \\$HOME"`,
		`C:\dir`:             `"C:\\\\dir"`,
		"--config-dir=/x y/": `"--config-dir=/x y/"`,
	}
	for in, want := range cases {
		if got := quote(in); got != want {
			t.Errorf("quote(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestEnableDisableRead(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "autostart")
	if _, ok, err := Read(dir); ok || err != nil {
		t.Fatalf("read before enable: %v %v", ok, err)
	}
	if _, err := Enable(dir, Entry{Binary: "openlive-helper"}); err == nil {
		t.Fatal("relative binary accepted")
	}
	path, err := Enable(dir, Entry{Binary: "/usr/bin/openlive-helper", Args: []string{"run", "--minimized"}, Name: "Openlive helper"})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != FileName {
		t.Errorf("path %s", path)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("stat %v %v", info, err)
	}
	exec, ok, err := Read(dir)
	if !ok || err != nil || exec != "/usr/bin/openlive-helper run --minimized" {
		t.Fatalf("read: %q %v %v", exec, ok, err)
	}
	// Enabling again replaces the entry.
	if _, err := Enable(dir, Entry{Binary: "/opt/openlive-helper", Args: []string{"run"}}); err != nil {
		t.Fatal(err)
	}
	if exec, _, _ := Read(dir); !strings.HasPrefix(exec, "/opt/") {
		t.Errorf("not replaced: %q", exec)
	}
	if removed, err := Disable(dir); !removed || err != nil {
		t.Fatalf("disable: %v %v", removed, err)
	}
	if removed, err := Disable(dir); removed || err != nil {
		t.Fatalf("disable twice: %v %v", removed, err)
	}
}

func TestDir(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/tmp/cfg")
	if d, _ := Dir(); d != "/tmp/cfg/autostart" {
		t.Errorf("Dir = %s", d)
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", "/home/me")
	if d, _ := Dir(); d != "/home/me/.config/autostart" {
		t.Errorf("Dir = %s", d)
	}
}

func TestEnsureLauncher(t *testing.T) {
	home, system := t.TempDir(), t.TempDir()
	t.Setenv("XDG_DATA_HOME", home)
	t.Setenv("XDG_DATA_DIRS", system)
	e := Entry{Binary: "/opt/openlive-helper", Args: []string{"run"}, Name: "Openlive helper"}
	written, err := EnsureLauncher(e, "<svg/>")
	if err != nil || !written {
		t.Fatalf("first: %v %v", written, err)
	}
	raw, err := os.ReadFile(filepath.Join(home, "applications", FileName))
	if err != nil || !strings.Contains(string(raw), "Exec=/opt/openlive-helper run\n") || strings.Contains(string(raw), "NoDisplay") {
		t.Fatalf("launcher: %v\n%s", err, raw)
	}
	if _, err := os.Stat(filepath.Join(home, "icons", "hicolor", "scalable", "apps", "dev.hfps.OpenliveHelper.svg")); err != nil {
		t.Fatal(err)
	}
	if written, _ := EnsureLauncher(e, "<svg/>"); written {
		t.Error("rewrote an up-to-date entry")
	}
	e.Binary = "/usr/local/bin/openlive-helper"
	if written, _ := EnsureLauncher(e, "<svg/>"); !written {
		t.Error("kept a stale entry")
	}
	// A packaged entry wins: nothing is written.
	if err := os.MkdirAll(filepath.Join(system, "applications"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(system, "applications", FileName), []byte("[Desktop Entry]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.Binary = "/elsewhere/openlive-helper"
	if written, err := EnsureLauncher(e, "<svg/>"); written || err != nil {
		t.Errorf("packaged: %v %v", written, err)
	}
}

func TestLaunchAgent(t *testing.T) {
	e := Entry{Binary: "/Applications/Openlive/openlive-helper", Args: []string{"run", "--instance", "https://a&b.example", "--minimized"}}
	plist := e.LaunchAgent("/tmp/logs/openlive-helper.log")
	for _, want := range []string{
		"<string>dev.hfps.OpenliveHelper</string>",
		"<string>https://a&amp;b.example</string>",
		"<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>",
		"<key>SuccessfulExit</key>\n\t\t<false/>",
		"<key>StandardErrorPath</key>",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("missing %q in\n%s", want, plist)
		}
	}
	if strings.Contains(plist, "EnvironmentVariables") {
		t.Errorf("no Env, but an EnvironmentVariables dict:\n%s", plist)
	}
	withEnv := Entry{Binary: e.Binary, Args: e.Args, Env: map[string]string{"LANG": "pt_BR.UTF-8", "A": "x<y"}}.LaunchAgent("")
	if !strings.Contains(withEnv, "<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>A</key>\n\t\t<string>x&lt;y</string>\n\t\t<key>LANG</key>") {
		t.Errorf("env not rendered in order:\n%s", withEnv)
	}
	if got := launchAgentProgram([]byte(withEnv)); !strings.HasSuffix(got, "--minimized") {
		t.Errorf("program with env %q", got)
	}
	if got := launchAgentProgram([]byte(plist)); got != "/Applications/Openlive/openlive-helper run --instance https://a&b.example --minimized" {
		t.Errorf("program %q", got)
	}

	launchAgents = true
	defer func() { launchAgents = false }()
	dir := t.TempDir()
	path, err := Enable(dir, e)
	if err != nil || filepath.Base(path) != "dev.hfps.OpenliveHelper.plist" {
		t.Fatal(path, err)
	}
	if exec, ok, err := Read(dir); err != nil || !ok || !strings.HasPrefix(exec, "/Applications/Openlive/openlive-helper run") {
		t.Errorf("read %q %v %v", exec, ok, err)
	}
	if removed, err := Disable(dir); !removed || err != nil {
		t.Errorf("disable %v %v", removed, err)
	}
	if written, err := EnsureLauncher(e, "<svg/>"); written || err != nil {
		t.Errorf("EnsureLauncher on macOS %v %v", written, err)
	}
}
