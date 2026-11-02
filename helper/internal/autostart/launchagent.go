// SPDX-License-Identifier: AGPL-3.0-only

package autostart

import (
	"bytes"
	"encoding/xml"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// On macOS the entry is a LaunchAgent: ~/Library/LaunchAgents/<label>.plist, which launchd
// starts in the user's GUI session at login (LimitLoadToSessionType Aqua: never in an SSH or
// background session, where ScreenCaptureKit does not work).

// LaunchAgentLabel is the agent's label and file name.
const LaunchAgentLabel = "dev.hfps.OpenliveHelper"

// launchAgents says whether this system uses LaunchAgents instead of XDG autostart.
var launchAgents = runtime.GOOS == "darwin"

// entryFile is the entry's file name on this system.
func entryFile() string {
	if launchAgents {
		return LaunchAgentLabel + ".plist"
	}
	return FileName
}

// launchAgentsDir is ~/Library/LaunchAgents.
func launchAgentsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents"), nil
}

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// LaunchAgent renders the entry as a LaunchAgent property list. launchd restarts the helper
// only after a crash (KeepAlive SuccessfulExit false): Quit in the tray or Ctrl+C stays quit.
// Its log goes to ~/Library/Logs/openlive-helper.log when Log is set; Env becomes its
// EnvironmentVariables.
func (e Entry) LaunchAgent(log string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + LaunchAgentLabel + `</string>
	<key>ProgramArguments</key>
	<array>
`)
	for _, a := range append([]string{e.Binary}, e.Args...) {
		b.WriteString("\t\t<string>" + xmlText(a) + "</string>\n")
	}
	b.WriteString(`	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Interactive</string>
`)
	if len(e.Env) > 0 {
		b.WriteString("\t<key>EnvironmentVariables</key>\n\t<dict>\n")
		keys := make([]string, 0, len(e.Env))
		for k := range e.Env {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			b.WriteString("\t\t<key>" + xmlText(k) + "</key>\n\t\t<string>" + xmlText(e.Env[k]) + "</string>\n")
		}
		b.WriteString("\t</dict>\n")
	}
	if log != "" {
		b.WriteString("\t<key>StandardOutPath</key>\n\t<string>" + xmlText(log) + "</string>\n")
		b.WriteString("\t<key>StandardErrorPath</key>\n\t<string>" + xmlText(log) + "</string>\n")
	}
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}

// launchAgentProgram reads the ProgramArguments back, space-joined (what status prints).
func launchAgentProgram(raw []byte) string {
	var doc struct {
		Dict struct {
			Items []struct {
				XMLName xml.Name
				Value   string   `xml:",chardata"`
				Strings []string `xml:"string"`
			} `xml:",any"`
		} `xml:"dict"`
	}
	if xml.Unmarshal(raw, &doc) != nil {
		return ""
	}
	for i, it := range doc.Dict.Items {
		if it.XMLName.Local == "key" && it.Value == "ProgramArguments" && i+1 < len(doc.Dict.Items) {
			return strings.Join(doc.Dict.Items[i+1].Strings, " ")
		}
	}
	return ""
}

// logPath is the LaunchAgent's log file.
func logPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "Library", "Logs", "openlive-helper.log")
}
