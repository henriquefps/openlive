// SPDX-License-Identifier: AGPL-3.0-only

package tray

import (
	"strings"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/i18n"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

var en = i18n.Catalog{Lang: i18n.En}

func find(items []Item, id int32) Item {
	for _, it := range items {
		if it.ID == id {
			return it
		}
	}
	return Item{}
}

func TestMenuStates(t *testing.T) {
	type want struct {
		status          string
		pause           Action
		pauseOn         bool
		curtain         Action
		curtainOn       bool
		checked         bool
		stopOn          bool
		icon            Icon
		detailsContains string
	}
	base := Status{Online: true, Instance: "https://openlive.example", Room: "Games", Preset: "1080p60", Viewers: 2}
	with := func(state protocol.HelperState, reason protocol.PauseReason) Status {
		s := base
		s.State, s.PauseReason = state, reason
		return s
	}
	offline := Status{Instance: "https://openlive.example", State: protocol.HelperStateIdle}
	cases := []struct {
		name string
		s    Status
		want want
	}{
		{"offline", offline, want{status: "Connecting to https://openlive.example", pause: Pause, curtain: CurtainOn, icon: IconIdle}},
		{"idle", with(protocol.HelperStateIdle, ""), want{status: "Ready", pause: Pause, curtain: CurtainOn, icon: IconIdle}},
		{"starting", with(protocol.HelperStateStarting, ""), want{status: "Starting", pause: Pause, curtain: CurtainOn, stopOn: true, icon: IconIdle, detailsContains: "Room: Games"}},
		{"live", with(protocol.HelperStateLive, ""), want{status: "Live", pause: Pause, pauseOn: true, curtain: CurtainOn, curtainOn: true, stopOn: true, icon: IconLive, detailsContains: "Viewers: 2"}},
		{"paused", with(protocol.HelperStatePaused, protocol.PauseReasonUser), want{status: "Paused", pause: Resume, pauseOn: true, curtain: CurtainOn, curtainOn: true, stopOn: true, icon: IconPaused}},
		{"curtain", with(protocol.HelperStatePaused, protocol.PauseReasonPrivacyCurtain), want{status: "Privacy curtain on", pause: Resume, pauseOn: true, curtain: CurtainOff, curtainOn: true, checked: true, stopOn: true, icon: IconPaused}},
		{"stopping", with(protocol.HelperStateStopping, ""), want{status: "Stopping", pause: Pause, curtain: CurtainOn, icon: IconIdle}},
		{"error", with(protocol.HelperStateError, ""), want{status: "failed", pause: Pause, curtain: CurtainOn, icon: IconIdle}},
	}
	for _, c := range cases {
		items := Menu(c.s, en)
		if got := items[0].Label; !strings.Contains(got, c.want.status) {
			t.Errorf("%s: status %q, want %q", c.name, got, c.want.status)
		}
		pause, curtain, stop := find(items, idPause), find(items, idCurtain), find(items, idStop)
		if pause.Action != c.want.pause || pause.Enabled != c.want.pauseOn {
			t.Errorf("%s: pause %+v", c.name, pause)
		}
		if curtain.Action != c.want.curtain || curtain.Enabled != c.want.curtainOn || curtain.Checked == nil || *curtain.Checked != c.want.checked {
			t.Errorf("%s: curtain %+v", c.name, curtain)
		}
		if stop.Enabled != c.want.stopOn {
			t.Errorf("%s: stop enabled %v", c.name, stop.Enabled)
		}
		for _, id := range []int32{idOpen, idPair, idQuit} {
			if !find(items, id).Enabled {
				t.Errorf("%s: item %d disabled", c.name, id)
			}
		}
		if got := IconFor(c.s); got != c.want.icon {
			t.Errorf("%s: icon %s, want %s", c.name, got, c.want.icon)
		}
		if c.want.detailsContains != "" {
			var labels []string
			for _, it := range items {
				labels = append(labels, it.Label)
			}
			if !strings.Contains(strings.Join(labels, "|"), c.want.detailsContains) {
				t.Errorf("%s: menu %v lacks %q", c.name, labels, c.want.detailsContains)
			}
		}
	}
}

func TestActionOf(t *testing.T) {
	live := Status{Online: true, State: protocol.HelperStateLive}
	if a, ok := ActionOf(idCurtain, live, en); !ok || a != CurtainOn {
		t.Errorf("curtain click while live = %s %v", a, ok)
	}
	idle := Status{Online: true, State: protocol.HelperStateIdle}
	if _, ok := ActionOf(idStop, idle, en); ok {
		t.Error("stop clickable while idle")
	}
	if _, ok := ActionOf(idStatus, live, en); ok {
		t.Error("the status line has an action")
	}
	if a, ok := ActionOf(idQuit, idle, en); !ok || a != Quit {
		t.Errorf("quit = %s %v", a, ok)
	}
	if _, ok := ActionOf(999, idle, en); ok {
		t.Error("unknown item has an action")
	}
}

func TestToggle(t *testing.T) {
	live := Status{State: protocol.HelperStateLive}
	curtain := Status{State: protocol.HelperStatePaused, PauseReason: protocol.PauseReasonPrivacyCurtain}
	paused := Status{State: protocol.HelperStatePaused, PauseReason: protocol.PauseReasonUser}
	cases := []struct {
		curtain bool
		s       Status
		want    Action
		ok      bool
	}{
		{true, live, CurtainOn, true},
		{true, curtain, CurtainOff, true},
		{true, paused, CurtainOn, true},
		{false, live, Pause, true},
		{false, curtain, Resume, true},
		{false, paused, Resume, true},
		{true, Status{State: protocol.HelperStateIdle}, "", false},
		{false, Status{State: protocol.HelperStateStarting}, "", false},
	}
	for _, c := range cases {
		if a, ok := Toggle(c.curtain, c.s); a != c.want || ok != c.ok {
			t.Errorf("Toggle(%v, %s/%s) = %s %v, want %s %v", c.curtain, c.s.State, c.s.PauseReason, a, ok, c.want, c.ok)
		}
	}
}

func TestPtBRMenu(t *testing.T) {
	items := Menu(Status{Online: true, State: protocol.HelperStateLive, Instance: "x"}, i18n.Catalog{Lang: i18n.PtBR})
	if items[0].Label != "Ao vivo" || find(items, idStop).Label != "Parar a transmissão" {
		t.Errorf("%+v", items)
	}
}

func TestIcons(t *testing.T) {
	for _, i := range []Icon{IconIdle, IconLive, IconPaused} {
		img := Render(i, 22)
		var ink int
		for p := 3; p < len(img.Pix); p += 4 {
			if img.Pix[p] > 0 {
				ink++
			}
		}
		// The glyph covers a good part of the icon, not a speck nor a full square.
		if ink < 22*22/6 || ink > 22*22*2/3 {
			t.Errorf("%s: %d inked pixels of %d", i, ink, 22*22)
		}
		px := pixmapOf(img)
		if px.W != 22 || len(px.Data) != 22*22*4 {
			t.Errorf("%s: pixmap %dx%d, %d bytes", i, px.W, px.H, len(px.Data))
		}
		svg := SVG(i)
		if !strings.Contains(svg, "<svg") || strings.Contains(svg, "ColorScheme-Text") != (i == IconIdle) {
			t.Errorf("%s: svg %s", i, svg)
		}
	}
}
