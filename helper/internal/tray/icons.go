// SPDX-License-Identifier: AGPL-3.0-only

package tray

import (
	"fmt"
	"image"
	"image/color"
	"math"
	"os"
	"path/filepath"
)

// The tray icon is the app glyph (apps/web/public/icon.svg, hfps-repo-assets: a broadcast
// dot and waves over a screen) without its olive square: monochrome while idle, red while
// live, amber while paused. On KDE the idle SVG follows the panel's text colour.

// Colours of the variants; idle's is the pixmap fallback for panels that ignore the SVG.
var iconColor = map[Icon]color.NRGBA{
	IconIdle:   {0x9a, 0x9b, 0x93, 0xff},
	IconLive:   {0xe5, 0x48, 0x4d, 0xff},
	IconPaused: {0xe0, 0x9b, 0x1a, 0xff},
}

// glyph is the app glyph in its 100 x 100 box, as in icon.svg.
const glyph = `<circle cx="50" cy="35" r="6" fill="currentColor"/>
<g stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M39.3 25.4 A14 14 0 0 1 60.7 25.4"/>
<path d="M30 14.6 A26 26 0 0 1 70 14.6" opacity="0.7"/>
<rect x="12" y="50" width="76" height="38" rx="9"/>
<path d="M36 98 H64"/>
</g>`

// SVG is the icon as an SVG file. The idle one uses KDE's ColorScheme-Text class, so
// Plasma paints it in the panel's text colour, light or dark.
func SVG(i Icon) string {
	c := iconColor[i]
	style, class := "", ""
	if i == IconIdle {
		style = fmt.Sprintf(`<style id="current-color-scheme">.ColorScheme-Text{color:#%02x%02x%02x;}</style>`, c.R, c.G, c.B)
		class = ` class="ColorScheme-Text"`
	}
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 2 92 100" width="22" height="22">%s<g%s style="color:#%02x%02x%02x">%s</g></svg>`+"\n",
		style, class, c.R, c.G, c.B, glyph)
}

// AppIcon is the full app icon (apps/web/public/icon.svg): the white glyph on the olive
// rounded square, for the launcher and the notifications.
func AppIcon() string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="512" height="512">` +
		`<rect width="128" height="128" rx="28" fill="#5b7a3a"/>` +
		`<g transform="translate(14 14) scale(0.78125)" style="color:#fff">` + glyph + "</g></svg>\n"
}

// IconName is the icon's name in the theme directory WriteTheme writes.
func IconName(i Icon) string { return "openlive-helper-" + string(i) }

// WriteTheme writes the SVG icons where IconThemePath can point: <dir>/hicolor/scalable/apps.
func WriteTheme(dir string) error {
	apps := filepath.Join(dir, "hicolor", "scalable", "apps")
	if err := os.MkdirAll(apps, 0o700); err != nil {
		return err
	}
	for _, i := range []Icon{IconIdle, IconLive, IconPaused} {
		if err := os.WriteFile(filepath.Join(apps, IconName(i)+".svg"), []byte(SVG(i)), 0o600); err != nil {
			return err
		}
	}
	return nil
}

// Render draws the glyph at size x size pixels, antialiased, for the IconPixmap fallback.
func Render(i Icon, size int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	c := iconColor[i]
	// The glyph's ink spans about x 8.5–91.5 and y 5.5–101.5: fit that 96-unit box.
	const span, ox, oy = 98.0, 50.0, 53.5
	unit := span / float64(size)
	for py := range size {
		for px := range size {
			x := ox + (float64(px)+0.5-float64(size)/2)*unit
			y := oy + (float64(py)+0.5-float64(size)/2)*unit
			a := coverage(x, y, unit)
			if a <= 0 {
				continue
			}
			img.SetNRGBA(px, py, color.NRGBA{c.R, c.G, c.B, uint8(math.Round(a * float64(c.A)))})
		}
	}
	return img
}

// coverage is how much of a pixel of width unit centred on (x, y) the glyph covers.
func coverage(x, y, unit float64) float64 {
	const half = 3.5 // stroke width 7
	ink := func(d float64) float64 { return clamp(0.5 - d/unit) }
	a := ink(math.Hypot(x-50, y-35) - 6)
	a = math.Max(a, ink(arcDist(x, y, 14, 39.3, 60.7, 25.4)-half))
	a = math.Max(a, 0.7*ink(arcDist(x, y, 26, 30, 70, 14.6)-half))
	a = math.Max(a, ink(math.Abs(roundRect(x, y, 12, 50, 76, 38, 9))-half))
	a = math.Max(a, ink(segment(x, y, 36, 98, 64, 98)-half))
	return a
}

// arcDist is the distance to a wave: the upper (minor) arc of radius r from (x0, yEnd) to
// (x1, yEnd), as the SVG path "M x0 yEnd A r r 0 0 1 x1 yEnd" draws it.
func arcDist(x, y, r, x0, x1, yEnd float64) float64 {
	cx, half := (x0+x1)/2, (x1-x0)/2
	cy := yEnd + math.Sqrt(r*r-half*half)
	dx, dy := x-cx, y-cy
	// Inside the arc's angle: above the lines from the centre through the two ends.
	if dy < 0 && math.Abs(dx)/-dy <= half/(cy-yEnd) {
		return math.Abs(math.Hypot(dx, dy) - r)
	}
	return math.Min(math.Hypot(x-x0, y-yEnd), math.Hypot(x-x1, y-yEnd))
}

// roundRect is the signed distance to a rounded rectangle (negative inside).
func roundRect(x, y, rx, ry, w, h, r float64) float64 {
	cx, cy := rx+w/2, ry+h/2
	qx := math.Abs(x-cx) - (w/2 - r)
	qy := math.Abs(y-cy) - (h/2 - r)
	return math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - r
}

func segment(x, y, x0, y0, x1, y1 float64) float64 {
	vx, vy := x1-x0, y1-y0
	t := clamp(((x-x0)*vx + (y-y0)*vy) / (vx*vx + vy*vy))
	return math.Hypot(x-(x0+t*vx), y-(y0+t*vy))
}

func clamp(v float64) float64 { return math.Max(0, math.Min(1, v)) }

// pixmap is an SNI IconPixmap entry: ARGB32 in network byte order.
type pixmap struct {
	W, H int32
	Data []byte
}

func pixmapOf(img *image.NRGBA) pixmap {
	b := img.Bounds()
	data := make([]byte, 0, b.Dx()*b.Dy()*4)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			c := img.NRGBAAt(x, y)
			data = append(data, c.A, c.R, c.G, c.B)
		}
	}
	return pixmap{W: int32(b.Dx()), H: int32(b.Dy()), Data: data}
}

// pixmapSizes covers the usual panel sizes and their 2x.
var pixmapSizes = []int{16, 22, 24, 32, 44, 48, 64}

func pixmaps(i Icon) []pixmap {
	out := make([]pixmap, 0, len(pixmapSizes))
	for _, s := range pixmapSizes {
		out = append(out, pixmapOf(Render(i, s)))
	}
	return out
}
