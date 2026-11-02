// SPDX-License-Identifier: AGPL-3.0-only

package overlay

import (
	"image"
	"strings"
	"testing"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

func TestLookAt(t *testing.T) {
	start, _ := LookAt(0)
	if start.Alpha != 0 || len(start.Rings) != 1 || start.Rings[0].Radius != ringMin {
		t.Errorf("at 0: %+v", start)
	}
	mid, done := LookAt(time.Second)
	if done || mid.Alpha != 1 || mid.Marker != 1 {
		t.Errorf("at 1 s: %+v done=%v", mid, done)
	}
	// Rings expand as they age and fade with it.
	a, _ := LookAt(200 * time.Millisecond)
	b, _ := LookAt(500 * time.Millisecond)
	if !(b.Rings[0].Radius > a.Rings[0].Radius && b.Rings[0].Alpha < a.Rings[0].Alpha) {
		t.Errorf("ring 200 ms %+v, 500 ms %+v", a.Rings[0], b.Rings[0])
	}
	if len(mid.Rings) != 1 || mid.Rings[0].Radius > ringMax {
		t.Errorf("rings at 1 s: %+v", mid.Rings)
	}
	end, _ := LookAt(Duration - 100*time.Millisecond)
	if end.Alpha <= 0 || end.Alpha >= 0.5 {
		t.Errorf("fading out: alpha %v", end.Alpha)
	}
	if _, done := LookAt(Duration); !done {
		t.Error("not done at the end")
	}
	for e := time.Duration(0); e < Duration; e += 10 * time.Millisecond {
		l, _ := LookAt(e)
		for _, r := range l.Rings {
			if r.Radius < ringMin || r.Radius > ringMax || r.Alpha < 0 || r.Alpha > 1 {
				t.Fatalf("at %v: ring %+v out of range", e, r)
			}
		}
		if l.Marker < 0 || l.Marker > 1.2 || l.Alpha < 0 || l.Alpha > 1 {
			t.Fatalf("at %v: %+v", e, l)
		}
	}
}

func TestPings(t *testing.T) {
	var p Pings
	t0 := time.Unix(1000, 0)
	p.Add(1, t0)
	p.Add(2, t0.Add(time.Second))
	frames, ended := p.Tick(t0.Add(1500 * time.Millisecond))
	if len(frames) != 2 || len(ended) != 0 {
		t.Fatalf("frames %v ended %v", frames, ended)
	}
	frames, ended = p.Tick(t0.Add(Duration))
	if len(ended) != 1 || ended[0] != 1 || len(frames) != 1 || frames[0].ID != 2 {
		t.Fatalf("frames %v ended %v", frames, ended)
	}
	if _, ended = p.Tick(t0.Add(time.Second + Duration)); len(ended) != 1 || p.Len() != 0 {
		t.Fatalf("ended %v, left %d", ended, p.Len())
	}

	// A crowd: the oldest ping gives way.
	for i := range uint32(MaxPings) {
		if _, ok := p.Add(100+i, t0); ok {
			t.Fatalf("evicted before the cap")
		}
	}
	if ev, ok := p.Add(999, t0); !ok || ev != 100 || p.Len() != MaxPings {
		t.Errorf("evicted %v %v, len %d", ev, ok, p.Len())
	}
	p.Remove(999)
	p.Remove(12345) // unknown: no-op
	if p.Len() != MaxPings-1 {
		t.Errorf("len %d", p.Len())
	}
}

func TestPlace(t *testing.T) {
	l := Place(1920, 1080, 960, 540, 50)
	if l.Left != 960-int(radius) || l.Top != 540-int(radius) || l.CX != radius || l.CY != radius {
		t.Errorf("centered: %+v", l)
	}
	if l.PillX <= l.CX || l.PillX+l.PillW > float64(l.W) {
		t.Errorf("pill right of the marker and inside: %+v", l)
	}
	// Near the right edge the name goes left of the marker.
	r := Place(1920, 1080, 1910, 540, 50)
	if r.PillX+r.PillW > r.CX || r.Left+r.W > 1920 || float64(r.Left)+r.CX != 1910 {
		t.Errorf("right edge: %+v", r)
	}
	// In a corner the surface stays on the output and the marker stays at the point.
	c := Place(1920, 1080, 3, 2, 50)
	if c.Left != 0 || c.Top != 0 || c.CX != 3 || c.CY != 2 || c.PillY < 0 {
		t.Errorf("corner: %+v", c)
	}
	b := Place(1920, 1080, 500, 1079, 50)
	if b.Top+b.H != 1080 || float64(b.Top)+b.CY != 1079 || b.PillY+pillH > float64(b.H) {
		t.Errorf("bottom edge: %+v", b)
	}
}

func TestShortName(t *testing.T) {
	if got := ShortName("  Ana   Maria "); got != "Ana Maria" {
		t.Errorf("%q", got)
	}
	if got := ShortName(""); got != "?" {
		t.Errorf("%q", got)
	}
	long := ShortName(strings.Repeat("é", 40))
	if !strings.HasSuffix(long, "…") || len([]rune(long)) != maxName {
		t.Errorf("%q (%d runes)", long, len([]rune(long)))
	}
}

func TestRender(t *testing.T) {
	for _, scale := range []float64{1, 1.25, 2} {
		face, err := Face(scale)
		if err != nil {
			t.Fatal(err)
		}
		name := "Bia"
		l := Place(1920, 1080, 500, 500, TextWidth(face, scale, name))
		w, h := int(float64(l.W)*scale+0.99), int(float64(l.H)*scale+0.99)
		img := image.NewRGBA(image.Rect(0, 0, w, h))
		look, _ := LookAt(time.Second)
		for _, shape := range protocol.PointerShapeValues {
			Render(img, l, scale, look, protocol.PointerStyle{Color: protocol.PointerColorRed, Shape: shape}, name, face)
			alpha := func(x, y float64) uint8 { return img.RGBAAt(int(x*scale), int(y*scale)).A }
			if a := alpha(l.CX, l.CY); shape != protocol.PointerShapeRing && a < 200 {
				t.Errorf("scale %v %s: marker center alpha %d", scale, shape, a)
			}
			if a := alpha(l.PillX+l.PillW/2, l.PillY+2); a < 200 {
				t.Errorf("scale %v %s: pill alpha %d", scale, shape, a)
			}
			if a := img.RGBAAt(0, h-1).A; a != 0 {
				t.Errorf("scale %v %s: corner not transparent (%d)", scale, shape, a)
			}
		}
		// The ring marker is hollow.
		Render(img, l, scale, look, protocol.PointerStyle{Color: protocol.PointerColorRed, Shape: protocol.PointerShapeRing}, name, face)
		if a := img.RGBAAt(int(l.CX*scale), int(l.CY*scale)).A; a > 120 {
			t.Errorf("scale %v: ring center alpha %d", scale, a)
		}
	}
}

func TestToARGB(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	copy(img.Pix, []byte{10, 20, 30, 40})
	dst := make([]byte, 4)
	toARGB(dst, img)
	if string(dst) != string([]byte{30, 20, 10, 40}) {
		t.Errorf("%v", dst)
	}
}

func TestTextOn(t *testing.T) {
	if c := textOn(Palette[protocol.PointerColorWhite]); c.R > 0x40 {
		t.Errorf("text on white: %v", c)
	}
	if c := textOn(Palette[protocol.PointerColorBlue]); c.R != 0xff {
		t.Errorf("text on blue: %v", c)
	}
	for _, c := range protocol.PointerColorValues {
		if _, ok := Palette[c]; !ok {
			t.Errorf("no color for %s", c)
		}
	}
}
