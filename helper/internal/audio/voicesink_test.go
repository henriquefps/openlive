// SPDX-License-Identifier: AGPL-3.0-only

package audio

import (
	"slices"
	"strings"
	"testing"
)

// voiceDump is a pw-dump while in voice and sharing the browser's window: the browser (pid
// 1201) plays a video tab to the speakers and the voice into the voice sink (helper 555),
// a second voice stream that has not been linked yet asks for the sink by serial, a third
// was moved from the voice sink to the speakers, and the voice sink's own output plays on
// the speakers. A dead helper's (444) leftover sink belongs to client 9, pid 7001.
const voiceDump = `[
  {"id": 30, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "alsa_output.speakers", "node.description": "Speakers", "media.class": "Audio/Sink", "object.serial": 30}}},
  {"id": 31, "type": "PipeWire:Interface:Port", "info": {"direction": "input", "props": {"node.id": 30, "port.name": "playback_FL", "audio.channel": "FL"}}},
  {"id": 32, "type": "PipeWire:Interface:Port", "info": {"direction": "input", "props": {"node.id": 30, "port.name": "playback_FR", "audio.channel": "FR"}}},
  {"id": 35, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "alsa_output.usb", "node.description": "USB Headset", "media.class": "Audio/Sink", "object.serial": 35}}},

  {"id": 100, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "openlive-voice", "node.description": "Openlive – voice", "media.class": "Audio/Sink", "object.serial": "9100", "openlive.voice-sink": true, "openlive.helper-pid": 555, "client.id": 8}}},
  {"id": 101, "type": "PipeWire:Interface:Port", "info": {"direction": "input", "props": {"node.id": 100, "port.name": "playback_FL", "audio.channel": "FL"}}},
  {"id": 102, "type": "PipeWire:Interface:Port", "info": {"direction": "input", "props": {"node.id": 100, "port.name": "playback_FR", "audio.channel": "FR"}}},
  {"id": 110, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "openlive-voice.output", "media.class": "Stream/Output/Audio", "openlive.voice-sink": "true", "openlive.helper-pid": "555", "client.id": 8}}},
  {"id": 111, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 110, "port.name": "output_FL", "audio.channel": "FL"}}},

  {"id": 40, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "Brave", "application.name": "Brave", "application.process.binary": "brave", "application.process.id": 1201, "media.class": "Stream/Output/Audio"}}},
  {"id": 41, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 40, "port.name": "output_FL", "audio.channel": "FL"}}},
  {"id": 42, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 40, "port.name": "output_FR", "audio.channel": "FR"}}},
  {"id": 50, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "Brave", "application.name": "Brave", "application.process.binary": "brave", "application.process.id": 1201, "media.class": "Stream/Output/Audio", "target.object": "openlive-voice"}}},
  {"id": 51, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 50, "port.name": "output_FL", "audio.channel": "FL"}}},
  {"id": 52, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 50, "port.name": "output_FR", "audio.channel": "FR"}}},
  {"id": 60, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "Brave", "application.name": "Brave", "application.process.id": 1201, "media.class": "Stream/Output/Audio", "target.object": "9100"}}},
  {"id": 61, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 60, "port.name": "output_MONO", "audio.channel": "MONO"}}},
  {"id": 65, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "Brave", "application.name": "Brave", "application.process.id": 1201, "media.class": "Stream/Output/Audio", "target.object": "openlive-voice"}}},
  {"id": 66, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 65, "port.name": "output_MONO", "audio.channel": "MONO"}}},

  {"id": 70, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "openlive-helper-audio-555", "media.class": "Stream/Input/Audio"}}},
  {"id": 71, "type": "PipeWire:Interface:Port", "info": {"direction": "input", "props": {"node.id": 70, "port.name": "input_FL", "audio.channel": "FL"}}},
  {"id": 72, "type": "PipeWire:Interface:Port", "info": {"direction": "input", "props": {"node.id": 70, "port.name": "input_FR", "audio.channel": "FR"}}},

  {"id": 200, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "openlive-voice", "node.description": "Openlive – voice", "media.class": "Audio/Sink", "openlive.voice-sink": true, "openlive.helper-pid": 444, "client.id": 9}}},
  {"id": 210, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "openlive-voice.output", "media.class": "Stream/Output/Audio", "openlive.voice-sink": true, "openlive.helper-pid": 444, "client.id": 9}}},

  {"id": 8, "type": "PipeWire:Interface:Client", "info": {"props": {"application.process.id": 6001}}},
  {"id": 9, "type": "PipeWire:Interface:Client", "info": {"props": {"pipewire.sec.pid": 7001}}},

  {"id": 80, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 41, "input-port-id": 31}},
  {"id": 81, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 42, "input-port-id": 32}},
  {"id": 82, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 51, "input-port-id": 101}},
  {"id": 83, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 52, "input-port-id": 102}},
  {"id": 84, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 66, "input-port-id": 31}},
  {"id": 85, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 111, "input-port-id": 31}},
  {"id": 86, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 51, "input-port-id": 71}},
  {"id": 87, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 52, "input-port-id": 72}}
]`

func voiceGraph(t *testing.T) Graph {
	t.Helper()
	g, err := ParseDump(strings.NewReader(voiceDump))
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestParseDumpVoiceSink(t *testing.T) {
	g := voiceGraph(t)
	n, ok := g.NodeByName("openlive-voice")
	if !ok || !n.VoiceSink || n.HelperPID != 555 || n.Description != "Openlive – voice" || n.ClientID != 8 {
		t.Fatalf("voice sink = %+v", n)
	}
	if g.Clients[8] != 6001 || g.Clients[9] != 7001 {
		t.Fatalf("clients = %v", g.Clients)
	}
	for _, n := range g.Nodes {
		if n.ID == 60 && n.Target != "9100" {
			t.Fatalf("target = %q", n.Target)
		}
		// A native PipeWire client's node has its pid on the client only.
		if n.ID == 110 && n.PID != 6001 {
			t.Fatalf("pid from the client = %d", n.PID)
		}
	}
}

func TestSourcesLeaveVoiceOut(t *testing.T) {
	g := voiceGraph(t)
	var ids []uint32
	for _, n := range g.Sources(Selector{PID: 1201}) {
		ids = append(ids, n.ID)
	}
	// 40 plays a video to the speakers; 50 plays into the voice sink (by its links, and it
	// asks for it), 60 is not linked yet but asks for the sink by serial. 65 asked for the
	// sink but was moved to the speakers: where it plays now counts.
	if want := []uint32{40, 65}; !slices.Equal(ids, want) {
		t.Fatalf("sources = %v, want %v", ids, want)
	}
	// The sink's own output is not an app anybody can pick.
	for _, a := range g.Apps() {
		if strings.HasPrefix(a.Name, "openlive-voice") {
			t.Fatalf("apps list the voice sink: %+v", a)
		}
	}
	if g.Sources(Selector{Name: "openlive-voice.output"}) != nil {
		t.Fatal("the voice sink's output can be captured by name")
	}
}

func TestPlanCaptureUnlinksVoice(t *testing.T) {
	g := voiceGraph(t)
	plan := g.PlanCapture(70, Selector{PID: 1201})
	// The voice stream (50) linked into the capture node is unlinked; the video (40) is linked.
	var removed []uint32
	for _, l := range plan.Remove {
		removed = append(removed, l.ID)
	}
	if !slices.Equal(removed, []uint32{86, 87}) {
		t.Fatalf("removed %v", removed)
	}
	var from []uint32
	for _, l := range plan.Create {
		from = append(from, l.Out)
	}
	if want := []uint32{41, 42, 66, 66}; !slices.Equal(from, want) {
		t.Fatalf("created from ports %v, want %v", from, want)
	}
}

func TestPlaysVoiceWithoutASink(t *testing.T) {
	// No voice sink: a target that only looks like one changes nothing.
	g := fakeGraph(t)
	for _, n := range g.Nodes {
		n.Target = "openlive-voice"
		if g.PlaysVoice(n) {
			t.Fatalf("node %d plays voice without a sink", n.ID)
		}
	}
}

func TestPlanVoiceSink(t *testing.T) {
	g := voiceGraph(t)
	alive := func(pid int) bool { return pid == 555 }
	plan := g.PlanVoiceSink(alive)
	if plan.Live == nil || plan.Live.ID != 100 {
		t.Fatalf("live = %+v", plan.Live)
	}
	if !slices.Equal(plan.Stale, []int{7001}) {
		t.Fatalf("stale = %v", plan.Stale)
	}
	// Every helper gone: no live sink (make one), both leftovers end.
	plan = g.PlanVoiceSink(func(int) bool { return false })
	if plan.Live != nil || !slices.Equal(plan.Stale, []int{6001, 7001}) {
		t.Fatalf("all gone = %+v", plan)
	}
	if plan := fakeGraph(t).PlanVoiceSink(alive); plan.Live != nil || plan.Stale != nil {
		t.Fatalf("no sinks = %+v", plan)
	}
}

func TestVoiceOutputAndSinkByLabel(t *testing.T) {
	g := voiceGraph(t)
	if out, ok := g.VoiceOutput(555); !ok || out.ID != 110 {
		t.Fatalf("output = %+v %v", out, ok)
	}
	if _, ok := g.VoiceOutput(1); ok {
		t.Fatal("another helper's output")
	}
	if s, ok := g.SinkByLabel("USB Headset"); !ok || s.Name != "alsa_output.usb" {
		t.Fatalf("by label = %+v", s)
	}
	if s, ok := g.SinkByLabel("alsa_output.speakers"); !ok || s.ID != 30 {
		t.Fatalf("by name = %+v", s)
	}
	for _, label := range []string{"", "Openlive – voice", "Nope"} {
		if s, ok := g.SinkByLabel(label); ok {
			t.Fatalf("%q = %+v", label, s)
		}
	}
}

func TestBrowserFamily(t *testing.T) {
	for _, tc := range []struct {
		names []string
		want  string
	}{
		{[]string{"brave", "brave-browser"}, BrowserChromium},
		{[]string{"", "google-chrome"}, BrowserChromium},
		{[]string{"chrome"}, BrowserChromium},
		{[]string{"com.brave.Browser"}, BrowserChromium},
		{[]string{"msedge"}, BrowserChromium},
		{[]string{"vivaldi-bin"}, BrowserChromium},
		{[]string{"firefox"}, BrowserFirefox},
		{[]string{"org.mozilla.firefox.desktop"}, BrowserFirefox},
		{[]string{"librewolf"}, BrowserFirefox},
		{[]string{"app.zen_browser.zen"}, BrowserFirefox},
		{[]string{"org.gnome.Epiphany"}, BrowserWebKit},
		// macOS: the sidecar reports the bundle id and the app name.
		{[]string{"com.google.Chrome", "Google Chrome"}, BrowserChromium},
		{[]string{"com.apple.Safari", "Safari"}, BrowserWebKit},
		{[]string{"com.microsoft.edgemac", "Microsoft Edge"}, BrowserChromium},
		{[]string{"company.thebrowser.Browser", "Arc"}, BrowserChromium},
		{[]string{"org.mozilla.firefox", "Firefox"}, BrowserFirefox},
		{[]string{"com.apple.Music", "Music"}, ""},
		{[]string{"steam", "steam_app_570"}, ""},
		{[]string{"Discord"}, ""},
		{nil, ""},
	} {
		if got := BrowserFamily(tc.names...); got != tc.want {
			t.Errorf("BrowserFamily(%q) = %q, want %q", tc.names, got, tc.want)
		}
	}
}
