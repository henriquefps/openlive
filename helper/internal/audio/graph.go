// SPDX-License-Identifier: AGPL-3.0-only

// Package audio captures one application's audio on Linux: a
// capture node that PipeWire never connects on its own (node.autoconnect=false), linked
// only to the chosen app's output ports, so other apps (a Discord call) stay out.
//
// The graph model and the link plan here are pure and tested on fake graphs; capture.go
// drives the real graph.
package audio

import (
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
)

// Node is a PipeWire node.
type Node struct {
	ID          uint32
	Serial      uint64
	Name        string
	Description string
	AppName     string
	Binary      string
	MediaClass  string
	MediaName   string
	PID         int
	// ClientID is the client (process connection) that owns the node.
	ClientID uint32
	// Target is where a stream asked to play (target.object, or the older node.target):
	// a node name or serial, empty for the default.
	Target string
	// VoiceSink marks the two nodes of a helper's voice sink (voicesink.go); HelperPID
	// is the helper that made them.
	VoiceSink bool
	HelperPID int
}

// Port is a node's port.
type Port struct {
	ID      uint32
	NodeID  uint32
	Name    string
	Channel string
	Output  bool
	Monitor bool
}

// Link joins an output port to an input port.
type Link struct {
	ID  uint32
	Out uint32
	In  uint32
}

// Graph is a snapshot of the PipeWire graph.
type Graph struct {
	Nodes []Node
	Ports []Port
	Links []Link
	// Clients maps a client id to its process id.
	Clients map[uint32]int
}

// appOutputClass is the media.class of an application's playback stream; sinkClass a
// device (or virtual device) streams play into.
const (
	appOutputClass = "Stream/Output/Audio"
	sinkClass      = "Audio/Sink"
)

// ParseDump reads the JSON array pw-dump prints.
func ParseDump(r io.Reader) (Graph, error) {
	var objs []struct {
		ID   uint32 `json:"id"`
		Type string `json:"type"`
		Info *struct {
			Direction    string         `json:"direction"`
			OutputPortID uint32         `json:"output-port-id"`
			InputPortID  uint32         `json:"input-port-id"`
			Props        map[string]any `json:"props"`
		} `json:"info"`
	}
	if err := json.NewDecoder(r).Decode(&objs); err != nil {
		return Graph{}, fmt.Errorf("pw-dump: %w", err)
	}
	g := Graph{Clients: map[uint32]int{}}
	for _, o := range objs {
		if o.Info == nil {
			continue
		}
		p := o.Info.Props
		switch o.Type[strings.LastIndex(o.Type, ":")+1:] {
		case "Node":
			target := scalar(p["target.object"])
			if target == "" {
				target = scalar(p["node.target"])
			}
			g.Nodes = append(g.Nodes, Node{
				ID:          o.ID,
				Serial:      uint64(num(p["object.serial"])),
				Name:        str(p["node.name"]),
				Description: str(p["node.description"]),
				AppName:     str(p["application.name"]),
				Binary:      str(p["application.process.binary"]),
				MediaClass:  str(p["media.class"]),
				MediaName:   str(p["media.name"]),
				PID:         int(num(p["application.process.id"])),
				ClientID:    uint32(num(p["client.id"])),
				Target:      target,
				VoiceSink:   truthy(p[voiceSinkProp]),
				HelperPID:   int(num(p[helperPIDProp])),
			})
		case "Port":
			g.Ports = append(g.Ports, Port{
				ID:      o.ID,
				NodeID:  uint32(num(p["node.id"])),
				Name:    str(p["port.name"]),
				Channel: str(p["audio.channel"]),
				Output:  o.Info.Direction == "output",
				Monitor: p["port.monitor"] == true,
			})
		case "Link":
			g.Links = append(g.Links, Link{ID: o.ID, Out: o.Info.OutputPortID, In: o.Info.InputPortID})
		case "Client":
			if pid := int(num(p["application.process.id"])); pid > 0 {
				g.Clients[o.ID] = pid
			} else if pid := int(num(p["pipewire.sec.pid"])); pid > 0 {
				g.Clients[o.ID] = pid
			}
		}
	}
	// PulseAudio clients (browsers) put their pid on the node; native PipeWire clients
	// (pw-play, apps on libpipewire) only on the client.
	for i, n := range g.Nodes {
		if n.PID == 0 {
			g.Nodes[i].PID = g.Clients[n.ClientID]
		}
	}
	return g, nil
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// scalar reads a string or a number as text ("-1", an unset target, is empty).
func scalar(v any) string {
	switch v := v.(type) {
	case string:
		if v == "-1" {
			return ""
		}
		return v
	case float64:
		if v < 0 {
			return ""
		}
		return fmt.Sprintf("%d", uint64(v))
	}
	return ""
}

// truthy reads a boolean property, which pw-dump may print as true or "true".
func truthy(v any) bool { return v == true || v == "true" || v == "1" }

// num reads a JSON number, or a number pw-dump wrote as a string.
func num(v any) float64 {
	switch v := v.(type) {
	case float64:
		return v
	case string:
		var f float64
		_, _ = fmt.Sscan(v, &f)
		return f
	}
	return 0
}

// App is an application that is playing audio.
type App struct {
	Name   string
	Binary string
	PIDs   []int
	// Nodes are its playback streams (a browser opens one per tab or player).
	Nodes []uint32
}

// appName is how an app is listed and selected: application.name, else node.name.
func (n Node) appName() string {
	if n.AppName != "" {
		return n.AppName
	}
	return n.Name
}

// Apps lists the applications with a playback stream, sorted by name.
func (g Graph) Apps() []App {
	byName := map[string]*App{}
	var names []string
	for _, n := range g.Nodes {
		if n.MediaClass != appOutputClass || g.PlaysVoice(n) {
			continue
		}
		name := n.appName()
		a, ok := byName[name]
		if !ok {
			a = &App{Name: name, Binary: n.Binary}
			byName[name] = a
			names = append(names, name)
		}
		a.Nodes = append(a.Nodes, n.ID)
		if n.PID > 0 && !slices.Contains(a.PIDs, n.PID) {
			a.PIDs = append(a.PIDs, n.PID)
		}
	}
	slices.SortFunc(names, func(a, b string) int { return strings.Compare(strings.ToLower(a), strings.ToLower(b)) })
	out := make([]App, 0, len(names))
	for _, n := range names {
		out = append(out, *byName[n])
	}
	return out
}

// Selector says whose audio to capture. Name matches application.name, the process
// binary or node.name (case-insensitive). PID matches the process or, when Descends is
// set, any of its descendants: browsers play audio from a child process, not the one that
// owns the window.
type Selector struct {
	Name     string
	PID      int
	Descends func(pid, ancestor int) bool
}

func (s Selector) empty() bool { return strings.TrimSpace(s.Name) == "" && s.PID <= 0 }

// String describes the selector in logs.
func (s Selector) String() string {
	switch {
	case s.Name != "" && s.PID > 0:
		return fmt.Sprintf("%q or pid %d", s.Name, s.PID)
	case s.PID > 0:
		return fmt.Sprintf("pid %d", s.PID)
	}
	return fmt.Sprintf("%q", s.Name)
}

func (s Selector) matches(n Node) bool {
	if name := strings.ToLower(strings.TrimSpace(s.Name)); name != "" {
		for _, v := range []string{n.AppName, n.Binary, n.Name} {
			if v != "" && strings.ToLower(v) == name {
				return true
			}
		}
	}
	if s.PID > 0 && n.PID > 0 {
		if n.PID == s.PID || (s.Descends != nil && s.Descends(n.PID, s.PID)) {
			return true
		}
	}
	return false
}

// Sources are the playback streams the selector picks.
func (g Graph) Sources(sel Selector) []Node {
	if sel.empty() {
		return nil
	}
	var out []Node
	for _, n := range g.Nodes {
		if n.MediaClass == appOutputClass && sel.matches(n) && !g.PlaysVoice(n) {
			out = append(out, n)
		}
	}
	return out
}

// VoiceSinks are the voice sinks in the graph (the Audio/Sink side of each).
func (g Graph) VoiceSinks() []Node {
	var out []Node
	for _, n := range g.Nodes {
		if n.VoiceSink && n.MediaClass == sinkClass {
			out = append(out, n)
		}
	}
	return out
}

// PlaysVoice reports whether a playback stream carries Openlive voice, which no capture
// may take: the voice sink's own output to the speakers, or a stream that
// plays into a voice sink. Links say where a stream plays now (streams move); a stream
// not linked into any sink yet is judged by the target it asked for.
func (g Graph) PlaysVoice(n Node) bool {
	if n.MediaClass != appOutputClass {
		return false
	}
	if n.VoiceSink {
		return true
	}
	voice := map[uint32]bool{}
	for _, s := range g.VoiceSinks() {
		voice[s.ID] = true
	}
	if len(voice) == 0 {
		return false
	}
	portNode := map[uint32]uint32{}
	for _, p := range g.Ports {
		portNode[p.ID] = p.NodeID
	}
	class := map[uint32]string{}
	for _, m := range g.Nodes {
		class[m.ID] = m.MediaClass
	}
	linked := false
	for _, l := range g.Links {
		if portNode[l.Out] != n.ID {
			continue
		}
		to := portNode[l.In]
		if voice[to] {
			return true
		}
		if class[to] == sinkClass {
			linked = true
		}
	}
	if linked || n.Target == "" {
		return false
	}
	for _, s := range g.VoiceSinks() {
		if n.Target == s.Name || n.Target == fmt.Sprint(s.Serial) || n.Target == fmt.Sprint(s.ID) {
			return true
		}
	}
	return false
}

// NodeByName finds a node by node.name.
func (g Graph) NodeByName(name string) (Node, bool) {
	for _, n := range g.Nodes {
		if n.Name == name {
			return n, true
		}
	}
	return Node{}, false
}

// channelOrder sorts ports FL, FR, then the rest by name, so index pairing is stable.
var channelOrder = []string{"MONO", "FL", "FR", "FC", "LFE", "RL", "RR", "SL", "SR"}

// PortsOf returns a node's audio ports in one direction, monitors excluded, in channel order.
func (g Graph) PortsOf(node uint32, output bool) []Port {
	var out []Port
	for _, p := range g.Ports {
		if p.NodeID == node && p.Output == output && !p.Monitor {
			out = append(out, p)
		}
	}
	slices.SortFunc(out, func(a, b Port) int {
		ia, ib := slices.Index(channelOrder, a.Channel), slices.Index(channelOrder, b.Channel)
		if ia < 0 {
			ia = len(channelOrder)
		}
		if ib < 0 {
			ib = len(channelOrder)
		}
		if ia != ib {
			return ia - ib
		}
		return strings.Compare(a.Name, b.Name)
	})
	return out
}

// PlanLinks pairs one source's output ports with the capture node's input ports: same
// channel first (FL→FL, FR→FR); a mono source feeds every input; otherwise by position,
// the last output repeated when the source has fewer channels.
func PlanLinks(outs, ins []Port) []Link {
	if len(outs) == 0 || len(ins) == 0 {
		return nil
	}
	var links []Link
	for i, in := range ins {
		out := outs[min(i, len(outs)-1)]
		if len(outs) == 1 {
			out = outs[0]
		} else if j := slices.IndexFunc(outs, func(o Port) bool { return o.Channel != "" && o.Channel == in.Channel }); j >= 0 {
			out = outs[j]
		}
		links = append(links, Link{Out: out.ID, In: in.ID})
	}
	return links
}

// Plan is the change that makes the capture node hear exactly the chosen app.
type Plan struct {
	// Create are links from the app's ports that are missing.
	Create []Link
	// Remove are links into the capture node from anything else (by link id).
	Remove []Link
}

// Empty reports whether the graph is already right.
func (p Plan) Empty() bool { return len(p.Create) == 0 && len(p.Remove) == 0 }

// PlanCapture compares the graph with what it should be: every playback stream the
// selector picks linked into the capture node, and nothing else linked into it.
func (g Graph) PlanCapture(capture uint32, sel Selector) Plan {
	ins := g.PortsOf(capture, false)
	inSet := map[uint32]bool{}
	for _, p := range ins {
		inSet[p.ID] = true
	}
	want := map[[2]uint32]bool{}
	for _, src := range g.Sources(sel) {
		for _, l := range PlanLinks(g.PortsOf(src.ID, true), ins) {
			want[[2]uint32{l.Out, l.In}] = true
		}
	}
	have := map[[2]uint32]bool{}
	var plan Plan
	for _, l := range g.Links {
		if !inSet[l.In] {
			continue
		}
		key := [2]uint32{l.Out, l.In}
		if want[key] {
			have[key] = true
		} else {
			plan.Remove = append(plan.Remove, l)
		}
	}
	for _, src := range g.Sources(sel) {
		for _, l := range PlanLinks(g.PortsOf(src.ID, true), ins) {
			if key := [2]uint32{l.Out, l.In}; !have[key] {
				have[key] = true
				plan.Create = append(plan.Create, l)
			}
		}
	}
	return plan
}
