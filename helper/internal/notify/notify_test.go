// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/i18n"
)

type fakeNotifier struct{ got []Notification }

func (f *fakeNotifier) Notify(n Notification) (uint32, error) {
	f.got = append(f.got, n)
	return uint32(len(f.got)), nil
}

type fakePlayer struct{ got []Sound }

func (f *fakePlayer) Play(s Sound) error { f.got = append(f.got, s); return nil }

func no() *bool  { b := false; return &b }
func yes() *bool { b := true; return &b }

func TestPolicyDefaults(t *testing.T) {
	p := NewPolicy(Settings{})
	for ev, want := range map[Event]bool{Started: true, Stopped: true, Dropped: true, Unstable: true, ViewerJoined: false, Curtain: true} {
		show, _ := p.Decide(ev)
		if show != want {
			t.Errorf("%s: show = %v, want %v", ev, show, want)
		}
	}
	if _, s := p.Decide(Started); s != SoundStart {
		t.Errorf("started sound = %q", s)
	}
	if _, s := p.Decide(Curtain); s != "" {
		t.Errorf("the curtain plays %q, want no sound", s)
	}
}

func TestPolicyMuteAndOff(t *testing.T) {
	muted := NewPolicy(Settings{Sounds: no()})
	if show, s := muted.Decide(Unstable); !show || s != "" {
		t.Errorf("muted: show %v sound %q", show, s)
	}
	// Notifications off still plays the sounds: they are a separate switch, as in the web.
	quiet := NewPolicy(Settings{Enabled: no()})
	if show, s := quiet.Decide(Started); show || s != SoundStart {
		t.Errorf("notifications off: show %v sound %q", show, s)
	}
	viewer := NewPolicy(Settings{ViewerJoined: yes(), Stopped: no()})
	if show, s := viewer.Decide(ViewerJoined); !show || s != SoundViewer {
		t.Errorf("viewer on: show %v sound %q", show, s)
	}
	if show, s := viewer.Decide(Dropped); show || s != "" {
		t.Errorf("stopped off also silences a drop: show %v sound %q", show, s)
	}
}

func TestCenterRateLimitsAndReplaces(t *testing.T) {
	now := time.Unix(1000, 0)
	n, p := &fakeNotifier{}, &fakePlayer{}
	c := &Center{Policy: NewPolicy(Settings{ViewerJoined: yes()}), Catalog: i18n.Catalog{Lang: i18n.En}, Notifier: n, Player: p, Now: func() time.Time { return now }}

	c.Post(Started, Args{Source: "Firefox", Room: "Games"})
	if len(n.got) != 1 || !strings.Contains(n.got[0].Body, "Firefox") || !strings.Contains(n.got[0].Body, "Games") || n.got[0].ReplacesID != 0 {
		t.Fatalf("started: %+v", n.got)
	}
	c.Post(Unstable, Args{})
	now = now.Add(time.Minute)
	c.Post(Unstable, Args{})
	if len(n.got) != 2 {
		t.Fatalf("unstable twice within 2 min shows %d notifications", len(n.got)-1)
	}
	now = now.Add(2 * time.Minute)
	c.Post(Unstable, Args{})
	c.Post(ViewerJoined, Args{Viewers: 2})
	c.Post(Stopped, Args{})
	if len(n.got) != 5 {
		t.Fatalf("got %d notifications", len(n.got))
	}
	// The stream's notification is replaced, not stacked.
	if last := n.got[4]; last.ReplacesID != 1 || !last.Transient {
		t.Errorf("stopped: %+v", last)
	}
	want := []Sound{SoundStart, SoundAlert, SoundAlert, SoundViewer, SoundStop}
	if len(p.got) != len(want) {
		t.Fatalf("sounds %v, want %v", p.got, want)
	}
	for i := range want {
		if p.got[i] != want[i] {
			t.Errorf("sounds %v, want %v", p.got, want)
		}
	}
}

func TestCenterPtBR(t *testing.T) {
	n := &fakeNotifier{}
	c := &Center{Policy: NewPolicy(Settings{}), Catalog: i18n.Catalog{Lang: i18n.PtBR}, Notifier: n}
	c.Post(Curtain, Args{On: true})
	if len(n.got) != 1 || !strings.HasPrefix(n.got[0].Summary, "Cortina de privacidade ligada") {
		t.Errorf("%+v", n.got)
	}
}

func TestWAV(t *testing.T) {
	for _, s := range Sounds {
		wav, err := WAV(s)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.HasPrefix(wav, []byte("RIFF")) || string(wav[8:16]) != "WAVEfmt " {
			t.Fatalf("%s: bad header", s)
		}
		size := binary.LittleEndian.Uint32(wav[40:44])
		if int(size) != len(wav)-44 || size == 0 {
			t.Errorf("%s: data size %d, file %d", s, size, len(wav))
		}
		if ms := int(size) / 2 * 1000 / sampleRate; ms > 600 {
			t.Errorf("%s lasts %d ms: notices must be short", s, ms)
		}
	}
	if _, err := WAV("nope"); err == nil {
		t.Error("unknown sound rendered")
	}
}

func TestNetworkWatch(t *testing.T) {
	w := &NetworkWatch{After: 3}
	feed := func(kbps int, loss float64) (bool, bool) { return w.Observe(kbps, loss) }
	// Ramp up: the target growing is not a cut.
	for _, k := range []int{1000, 3000, 8000, 8000} {
		if u, _ := feed(k, 0); u {
			t.Fatal("unstable while ramping up")
		}
	}
	// A short dip stays quiet.
	feed(2000, 0)
	feed(2000, 0)
	if u, _ := feed(8000, 0); u {
		t.Fatal("unstable after a short dip")
	}
	feed(3000, 0)
	feed(3000, 0)
	if u, changed := feed(3000, 0); !u || !changed {
		t.Fatalf("3 cut samples: unstable %v changed %v", u, changed)
	}
	if u, changed := feed(3000, 0); !u || changed {
		t.Fatal("unstable should be reported once")
	}
	feed(7000, 0)
	feed(7000, 0)
	if u, changed := feed(7000, 0); u || !changed {
		t.Fatal("not stable again after 3 good samples")
	}
	for range 3 {
		feed(8000, 12)
	}
	if u, _ := feed(8000, 12); !u {
		t.Fatal("loss does not count")
	}
	w.Reset()
	if u, _ := feed(500, 0); u || w.After != 3 {
		t.Fatal("reset kept the state or lost the settings")
	}
}

func TestAppleScript(t *testing.T) {
	n := Notification{Summary: `Live in "Games"`, Body: "a\\b\nc"}
	if got, want := n.script(), `display notification "a\\b c" with title "Live in \"Games\""`; got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}
