// SPDX-License-Identifier: AGPL-3.0-only

package overlay

import (
	"image"
	"image/color"
	"image/draw"
	"math"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Palette is the RGB of each pointer color (PROTOCOL.md §7.9's closed list).
var Palette = map[protocol.PointerColor]color.NRGBA{
	protocol.PointerColorOlive:  {0x8a, 0x9a, 0x4b, 0xff},
	protocol.PointerColorRed:    {0xe5, 0x48, 0x4d, 0xff},
	protocol.PointerColorOrange: {0xf7, 0x6b, 0x15, 0xff},
	protocol.PointerColorYellow: {0xff, 0xc5, 0x3d, 0xff},
	protocol.PointerColorGreen:  {0x30, 0xa4, 0x6c, 0xff},
	protocol.PointerColorCyan:   {0x00, 0xa2, 0xc7, 0xff},
	protocol.PointerColorBlue:   {0x3e, 0x63, 0xdd, 0xff},
	protocol.PointerColorPurple: {0x8e, 0x4e, 0xc6, 0xff},
	protocol.PointerColorPink:   {0xd6, 0x40, 0x9f, 0xff},
	protocol.PointerColorWhite:  {0xff, 0xff, 0xff, 0xff},
}

// colorOf falls back to olive for a color this build does not know.
func colorOf(c protocol.PointerColor) color.NRGBA {
	if v, ok := Palette[c]; ok {
		return v
	}
	return Palette[protocol.PointerColorOlive]
}

// Label sizes in logical pixels.
const (
	fontSize  = 13.0
	pillH     = 24.0
	pillPad   = 9.0
	pillGap   = 18.0 // from the marker's center to the pill
	maxName   = 32   // runes
	ringWidth = 3.0
)

// Layout places one ping's surface on its output and the marker and name inside it. All
// values are logical pixels; the surface is a small box around the ping, not the whole
// output.
type Layout struct {
	// Left and Top are the surface's position on the output, W and H its size.
	Left, Top, W, H int
	// CX, CY is the marker's center in the surface.
	CX, CY float64
	// The name's pill.
	PillX, PillY, PillW float64
}

// Place lays out a ping at x, y of an output of outW x outH whose name is textW wide. The
// name goes right of the marker, or left of it near the right edge; the surface stays on
// the output, so a ping at an edge shows part of its rings.
func Place(outW, outH int, x, y, textW float64) Layout {
	pillW := math.Ceil(textW + 2*pillPad)
	side := math.Max(radius, pillGap+pillW+margin)
	w := int(math.Ceil(radius + side))
	h := int(2 * radius)
	flip := x+pillGap+pillW+margin > float64(outW)
	cx := radius
	if flip {
		cx = float64(w) - radius
	}
	left := clampInt(int(math.Round(x-cx)), 0, outW-w)
	top := clampInt(int(math.Round(y-radius)), 0, outH-h)
	l := Layout{Left: left, Top: top, W: w, H: h, CX: x - float64(left), CY: y - float64(top), PillW: pillW}
	l.PillX = l.CX + pillGap
	if flip {
		l.PillX = l.CX - pillGap - pillW
	}
	l.PillY = math.Min(math.Max(l.CY-pillH/2, 0), float64(h)-pillH)
	return l
}

func clampInt(v, lo, hi int) int {
	if hi < lo {
		hi = lo
	}
	return min(max(v, lo), hi)
}

// ShortName trims a display name for the pill.
func ShortName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return "?"
	}
	if utf8.RuneCountInString(name) <= maxName {
		return name
	}
	r := []rune(name)
	return strings.TrimSpace(string(r[:maxName-1])) + "…"
}

var (
	fontOnce sync.Once
	fontData *opentype.Font
	fontErr  error
	faceMu   sync.Mutex
	faces    = map[float64]font.Face{}
)

// Face is the name's font at a buffer scale.
func Face(scale float64) (font.Face, error) {
	fontOnce.Do(func() { fontData, fontErr = opentype.Parse(gobold.TTF) })
	if fontErr != nil {
		return nil, fontErr
	}
	faceMu.Lock()
	defer faceMu.Unlock()
	if f, ok := faces[scale]; ok {
		return f, nil
	}
	f, err := opentype.NewFace(fontData, &opentype.FaceOptions{Size: fontSize * scale, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		return nil, err
	}
	faces[scale] = f
	return f, nil
}

// TextWidth is the name's width in logical pixels.
func TextWidth(face font.Face, scale float64, name string) float64 {
	return float64(font.MeasureString(face, name)) / 64 / scale
}

// Render draws one frame of a ping into img, whose pixels are the layout's logical pixels
// times scale. img is cleared first.
func Render(img *image.RGBA, l Layout, scale float64, look Look, style protocol.PointerStyle, name string, face font.Face) {
	clear(img.Pix)
	b := img.Bounds()
	z := vector.NewRasterizer(b.Dx(), b.Dy())
	z.DrawOp = draw.Over
	c := colorOf(style.Color)
	fill := func(col color.NRGBA, alpha float64, path func(p *pen)) {
		if alpha <= 0 {
			return
		}
		z.Reset(b.Dx(), b.Dy())
		z.DrawOp = draw.Over
		path(&pen{z: z, s: scale})
		col.A = uint8(math.Round(float64(col.A) * math.Min(1, alpha)))
		z.Draw(img, b, image.NewUniform(col), image.Point{})
	}
	shadow := color.NRGBA{0, 0, 0, 0xff}

	for _, r := range look.Rings {
		fill(shadow, 0.35*r.Alpha, func(p *pen) { p.annulus(l.CX, l.CY+0.5, r.Radius+1, ringWidth+2) })
		fill(c, r.Alpha, func(p *pen) { p.annulus(l.CX, l.CY, r.Radius, ringWidth) })
	}

	if m := look.Marker; m > 0 {
		marker := func(p *pen, dy float64) { p.shape(style.Shape, l.CX, l.CY+dy, m) }
		fill(shadow, 0.45*look.Alpha, func(p *pen) { marker(p, 1) })
		if style.Shape == protocol.PointerShapeDot {
			// A white edge so a dot shows on a background of its own color.
			fill(color.NRGBA{0xff, 0xff, 0xff, 0xff}, look.Alpha, func(p *pen) { p.circle(l.CX, l.CY, 8.5*m, false) })
		}
		fill(c, look.Alpha, func(p *pen) { marker(p, 0) })
	}

	// The name in a pill of the sender's color.
	fill(shadow, 0.35*look.Alpha, func(p *pen) { p.roundRect(l.PillX, l.PillY+1, l.PillW, pillH, pillH/2) })
	fill(c, 0.95*look.Alpha, func(p *pen) { p.roundRect(l.PillX, l.PillY, l.PillW, pillH, pillH/2) })
	if face != nil && look.Alpha > 0 {
		text := textOn(c)
		text.A = uint8(math.Round(255 * look.Alpha))
		m := face.Metrics()
		baseline := (l.PillY+pillH/2)*scale + float64(m.Ascent-m.Descent)/64/2
		d := font.Drawer{Dst: img, Src: image.NewUniform(text), Face: face,
			Dot: fixed.Point26_6{X: fixed.Int26_6((l.PillX + pillPad) * scale * 64), Y: fixed.Int26_6(baseline * 64)}}
		d.DrawString(name)
	}
}

// textOn picks dark text on light colors and white text on the rest.
func textOn(c color.NRGBA) color.NRGBA {
	lum := 0.2126*float64(c.R) + 0.7152*float64(c.G) + 0.0722*float64(c.B)
	if lum > 150 {
		return color.NRGBA{0x1a, 0x1c, 0x14, 0xff}
	}
	return color.NRGBA{0xff, 0xff, 0xff, 0xff}
}

// pen draws paths in logical pixels on a rasterizer in buffer pixels.
type pen struct {
	z *vector.Rasterizer
	s float64
}

func (p *pen) move(x, y float64) { p.z.MoveTo(float32(x*p.s), float32(y*p.s)) }
func (p *pen) line(x, y float64) { p.z.LineTo(float32(x*p.s), float32(y*p.s)) }
func (p *pen) cube(x1, y1, x2, y2, x, y float64) {
	p.z.CubeTo(float32(x1*p.s), float32(y1*p.s), float32(x2*p.s), float32(y2*p.s), float32(x*p.s), float32(y*p.s))
}

// circle adds a circle; reverse winds it the other way, which cuts a hole.
func (p *pen) circle(cx, cy, r float64, reverse bool) {
	const k = 0.5522847498
	kr := k * r
	if !reverse {
		p.move(cx+r, cy)
		p.cube(cx+r, cy+kr, cx+kr, cy+r, cx, cy+r)
		p.cube(cx-kr, cy+r, cx-r, cy+kr, cx-r, cy)
		p.cube(cx-r, cy-kr, cx-kr, cy-r, cx, cy-r)
		p.cube(cx+kr, cy-r, cx+r, cy-kr, cx+r, cy)
	} else {
		p.move(cx+r, cy)
		p.cube(cx+r, cy-kr, cx+kr, cy-r, cx, cy-r)
		p.cube(cx-kr, cy-r, cx-r, cy-kr, cx-r, cy)
		p.cube(cx-r, cy+kr, cx-kr, cy+r, cx, cy+r)
		p.cube(cx+kr, cy+r, cx+r, cy+kr, cx+r, cy)
	}
	p.z.ClosePath()
}

// annulus is a ring of width w centered on radius r.
func (p *pen) annulus(cx, cy, r, w float64) {
	outer, inner := r+w/2, math.Max(0, r-w/2)
	p.circle(cx, cy, outer, false)
	if inner > 0 {
		p.circle(cx, cy, inner, true)
	}
}

func (p *pen) rect(x, y, w, h float64) {
	p.move(x, y)
	p.line(x+w, y)
	p.line(x+w, y+h)
	p.line(x, y+h)
	p.z.ClosePath()
}

func (p *pen) roundRect(x, y, w, h, r float64) {
	r = math.Min(r, math.Min(w, h)/2)
	const k = 0.5522847498
	kr := k * r
	p.move(x+r, y)
	p.line(x+w-r, y)
	p.cube(x+w-r+kr, y, x+w, y+r-kr, x+w, y+r)
	p.line(x+w, y+h-r)
	p.cube(x+w, y+h-r+kr, x+w-r+kr, y+h, x+w-r, y+h)
	p.line(x+r, y+h)
	p.cube(x+r-kr, y+h, x, y+h-r+kr, x, y+h-r)
	p.line(x, y+r)
	p.cube(x, y+r-kr, x+r-kr, y, x+r, y)
	p.z.ClosePath()
}

// shape adds the marker at size m (1 is full size).
func (p *pen) shape(s protocol.PointerShape, cx, cy, m float64) {
	switch s {
	case protocol.PointerShapeDot:
		p.circle(cx, cy, 6.5*m, false)
	case protocol.PointerShapeCrosshair:
		arm, gap, w := 11*m, 3.5*m, 3*m
		p.rect(cx-w/2, cy-gap-arm, w, arm)
		p.rect(cx-w/2, cy+gap, w, arm)
		p.rect(cx-gap-arm, cy-w/2, arm, w)
		p.rect(cx+gap, cy-w/2, arm, w)
		p.circle(cx, cy, 1.8*m, false)
	case protocol.PointerShapeStar:
		outer, inner := 11.5*m, 4.8*m
		for i := range 10 {
			r := outer
			if i%2 == 1 {
				r = inner
			}
			a := -math.Pi/2 + float64(i)*math.Pi/5
			x, y := cx+r*math.Cos(a), cy+r*math.Sin(a)
			if i == 0 {
				p.move(x, y)
			} else {
				p.line(x, y)
			}
		}
		p.z.ClosePath()
	default: // ring
		p.annulus(cx, cy, 7*m, 3.5*m)
	}
}

// toARGB copies img into a wl_shm ARGB8888 buffer: premultiplied, B G R A in memory.
func toARGB(dst []byte, img *image.RGBA) {
	src := img.Pix
	n := min(len(dst), len(src))
	for i := 0; i+3 < n; i += 4 {
		dst[i], dst[i+1], dst[i+2], dst[i+3] = src[i+2], src[i+1], src[i], src[i+3]
	}
}
