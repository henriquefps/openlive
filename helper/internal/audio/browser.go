// SPDX-License-Identifier: AGPL-3.0-only

package audio

import "strings"

// Browser families, as protocol.BrowserFamily names them.
const (
	BrowserChromium = "chromium"
	BrowserFirefox  = "firefox"
	BrowserWebKit   = "webkit"
)

// browserNames maps what a browser's process, window class or app id contains to its
// family. Order matters: "chrome" must not catch a Firefox fork's longer name first.
var browserNames = []struct{ part, family string }{
	{"firefox", BrowserFirefox},
	{"librewolf", BrowserFirefox},
	{"floorp", BrowserFirefox},
	{"waterfox", BrowserFirefox},
	{"zen-browser", BrowserFirefox},
	{"mullvad", BrowserFirefox},
	{"torbrowser", BrowserFirefox},
	{"tor-browser", BrowserFirefox},
	{"icecat", BrowserFirefox},
	{"chrome", BrowserChromium},
	{"chromium", BrowserChromium},
	{"brave", BrowserChromium},
	{"msedge", BrowserChromium},
	{"microsoft-edge", BrowserChromium},
	{"opera", BrowserChromium},
	{"vivaldi", BrowserChromium},
	{"thorium", BrowserChromium},
	{"yandex", BrowserChromium},
	{"epiphany", BrowserWebKit},
	{"webkit", BrowserWebKit},
	// macOS bundle ids and app names: com.apple.Safari, com.microsoft.edgemac ("Microsoft
	// Edge"), company.thebrowser.Browser (Arc).
	{"safari", BrowserWebKit},
	{"edgemac", BrowserChromium},
	{"microsoft edge", BrowserChromium},
	{"thebrowser", BrowserChromium},
}

// exactBrowserNames are names too short to look for inside others.
var exactBrowserNames = map[string]string{"zen": BrowserFirefox, "zen-bin": BrowserFirefox, "helium": BrowserChromium}

// BrowserFamily guesses, from a process name, window class or app id ("brave",
// "org.mozilla.firefox", "google-chrome"), whether an app is a web browser and which
// family; "" when none of names looks like one. A heuristic: it only feeds a warning.
func BrowserFamily(names ...string) string {
	for _, name := range names {
		n := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(name), ".desktop"))
		if n == "" {
			continue
		}
		last := n[strings.LastIndexByte(n, '.')+1:]
		if f, ok := exactBrowserNames[last]; ok {
			return f
		}
		for _, b := range browserNames {
			if strings.Contains(n, b.part) {
				return b.family
			}
		}
	}
	return ""
}

// ProcessName is a process's command name (/proc/<pid>/comm), "" when unknown.
func ProcessName(pid int) string {
	if pid <= 0 {
		return ""
	}
	return comm(pid)
}
