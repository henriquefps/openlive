// SPDX-License-Identifier: AGPL-3.0-only

package audio

import (
	"slices"
	"strings"
	"testing"
)

// fakeDump is a trimmed pw-dump: a browser playing from a child process, a Discord call,
// a mono app, the speakers, and the helper's capture node with one foreign link into it.
const fakeDump = `[
  {"id": 30, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "alsa_output.speakers", "media.class": "Audio/Sink", "object.serial": 30}}},
  {"id": 40, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "Brave", "application.name": "Brave", "application.process.binary": "brave", "application.process.id": 1201, "media.class": "Stream/Output/Audio", "object.serial": "4040"}}},
  {"id": 41, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 40, "port.name": "output_FL", "audio.channel": "FL"}}},
  {"id": 42, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 40, "port.name": "output_FR", "audio.channel": "FR"}}},
  {"id": 50, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "WEBRTC VoiceEngine", "application.name": "Discord", "application.process.binary": "Discord", "application.process.id": 900, "media.class": "Stream/Output/Audio"}}},
  {"id": 51, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 50, "port.name": "output_FL", "audio.channel": "FL"}}},
  {"id": 52, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 50, "port.name": "output_FR", "audio.channel": "FR"}}},
  {"id": 60, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "mpv", "application.process.id": 3000, "media.class": "Stream/Output/Audio"}}},
  {"id": 61, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 60, "port.name": "output_MONO", "audio.channel": "MONO"}}},
  {"id": 70, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "openlive-helper-audio-77", "media.class": "Stream/Input/Audio"}}},
  {"id": 71, "type": "PipeWire:Interface:Port", "info": {"direction": "input", "props": {"node.id": 70, "port.name": "input_FR", "audio.channel": "FR"}}},
  {"id": 72, "type": "PipeWire:Interface:Port", "info": {"direction": "input", "props": {"node.id": 70, "port.name": "input_FL", "audio.channel": "FL"}}},
  {"id": 73, "type": "PipeWire:Interface:Port", "info": {"direction": "output", "props": {"node.id": 70, "port.name": "monitor_FL", "port.monitor": true}}},
  {"id": 80, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 41, "input-port-id": 72}},
  {"id": 81, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 51, "input-port-id": 71}},
  {"id": 82, "type": "PipeWire:Interface:Link", "info": {"output-port-id": 51, "input-port-id": 999}},
  {"id": 90, "type": "PipeWire:Interface:Client", "info": null}
]`

func fakeGraph(t *testing.T) Graph {
	t.Helper()
	g, err := ParseDump(strings.NewReader(fakeDump))
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestParseDump(t *testing.T) {
	g := fakeGraph(t)
	if len(g.Nodes) != 5 || len(g.Ports) != 8 || len(g.Links) != 3 {
		t.Fatalf("%d nodes, %d ports, %d links", len(g.Nodes), len(g.Ports), len(g.Links))
	}
	n, ok := g.NodeByName("Brave")
	if !ok || n.PID != 1201 || n.Serial != 4040 || n.Binary != "brave" {
		t.Fatalf("Brave node %+v", n)
	}
}

func TestApps(t *testing.T) {
	var names []string
	for _, a := range fakeGraph(t).Apps() {
		names = append(names, a.Name)
	}
	// The speakers and the helper's own capture node are not apps; mpv has only node.name.
	if want := []string{"Brave", "Discord", "mpv"}; !slices.Equal(names, want) {
		t.Fatalf("apps %v, want %v", names, want)
	}
}

func TestSources(t *testing.T) {
	g := fakeGraph(t)
	ids := func(sel Selector) []uint32 {
		var out []uint32
		for _, n := range g.Sources(sel) {
			out = append(out, n.ID)
		}
		return out
	}
	if got := ids(Selector{Name: "discord"}); !slices.Equal(got, []uint32{50}) {
		t.Errorf("by application.name: %v", got)
	}
	if got := ids(Selector{Name: "brave"}); !slices.Equal(got, []uint32{40}) {
		t.Errorf("by binary: %v", got)
	}
	// The window belongs to pid 1000; Brave plays from its child 1201.
	tree := map[int]int{1201: 1100, 1100: 1000}
	descends := func(pid, ancestor int) bool {
		for ; pid > 0; pid = tree[pid] {
			if pid == ancestor {
				return true
			}
		}
		return false
	}
	if got := ids(Selector{PID: 1000, Descends: descends}); !slices.Equal(got, []uint32{40}) {
		t.Errorf("by window pid: %v", got)
	}
	if got := ids(Selector{PID: 1000}); got != nil {
		t.Errorf("pid without descendants matched %v", got)
	}
	if got := ids(Selector{}); got != nil {
		t.Errorf("empty selector matched %v", got)
	}
}

func TestPlanLinks(t *testing.T) {
	g := fakeGraph(t)
	ins := g.PortsOf(70, false) // FL, FR after sorting; the monitor port is left out
	if len(ins) != 2 || ins[0].Channel != "FL" || ins[1].Channel != "FR" {
		t.Fatalf("capture inputs %+v", ins)
	}
	stereo := PlanLinks(g.PortsOf(40, true), ins)
	if want := []Link{{Out: 41, In: 72}, {Out: 42, In: 71}}; !slices.Equal(stereo, want) {
		t.Errorf("stereo %v, want %v", stereo, want)
	}
	mono := PlanLinks(g.PortsOf(60, true), ins)
	if want := []Link{{Out: 61, In: 72}, {Out: 61, In: 71}}; !slices.Equal(mono, want) {
		t.Errorf("mono %v, want %v", mono, want)
	}
	// Unnamed channels pair by position; a shorter source repeats its last port.
	outs := []Port{{ID: 1}, {ID: 2}}
	in3 := []Port{{ID: 10}, {ID: 11}, {ID: 12}}
	if got, want := PlanLinks(outs, in3), []Link{{Out: 1, In: 10}, {Out: 2, In: 11}, {Out: 2, In: 12}}; !slices.Equal(got, want) {
		t.Errorf("by position %v, want %v", got, want)
	}
	if PlanLinks(nil, ins) != nil {
		t.Error("links from nothing")
	}
}

func TestPlanCapture(t *testing.T) {
	g := fakeGraph(t)
	plan := g.PlanCapture(70, Selector{Name: "Brave"})
	// Brave FL→FL exists; FR→FR is missing; Discord's link into the capture node goes;
	// Discord's link elsewhere (82) is not ours to touch.
	if want := []Link{{Out: 42, In: 71}}; !slices.Equal(plan.Create, want) {
		t.Errorf("create %v, want %v", plan.Create, want)
	}
	if len(plan.Remove) != 1 || plan.Remove[0].ID != 81 {
		t.Errorf("remove %v, want link 81", plan.Remove)
	}
	// Once applied, nothing is left to do.
	g.Links = []Link{{ID: 80, Out: 41, In: 72}, {ID: 83, Out: 42, In: 71}, {ID: 82, Out: 51, In: 999}}
	if plan := g.PlanCapture(70, Selector{Name: "Brave"}); !plan.Empty() {
		t.Errorf("settled graph still plans %+v", plan)
	}
	// An app that is not playing: nothing to link, and foreign links still go.
	g.Links = append(g.Links, Link{ID: 84, Out: 51, In: 72})
	plan = g.PlanCapture(70, Selector{Name: "Spotify"})
	if len(plan.Create) != 0 || len(plan.Remove) != 3 {
		t.Errorf("absent app: %+v", plan)
	}
}

func TestParseStatPPID(t *testing.T) {
	cases := map[string]int{
		"1201 (brave) S 1100 1201 1000 0 -1":            1100,
		"77 (Web Content (x) ) R 42 77 77 0 -1 4194560": 42,
		"garbage": 0,
	}
	for in, want := range cases {
		if got := ParseStatPPID(in); got != want {
			t.Errorf("ParseStatPPID(%q) = %d, want %d", in, got, want)
		}
	}
}
