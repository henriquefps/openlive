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

// The tray icon is the app glyph (apps/web/public/icon.svg, hfps-repo-assets: a monitor and its
// stand with a solid "live" circle in front) without its olive square: monochrome while idle, red while
// live, amber while paused. On KDE the idle SVG follows the panel's text colour.

// Colours of the variants; idle's is the pixmap fallback for panels that ignore the SVG.
var iconColor = map[Icon]color.NRGBA{
	IconIdle:   {0x9a, 0x9b, 0x93, 0xff},
	IconLive:   {0xe5, 0x48, 0x4d, 0xff},
	IconPaused: {0xe0, 0x9b, 0x1a, 0xff},
}

// glyph is the app glyph in its 128 x 128 box, as in scripts/glyph.svg (the monitor at 70% and the
// stand at 45% are knocked out around the circle).
const glyph = `<path d="M29.806 28.251L85.76 28.251C90.91 28.251 95.086 32.427 95.086 37.577L95.086 60.321C93.184 59.777 91.218 59.616 89.208 59.481C80.292 58.881 72.991 64.873 69.087 72.365C67.892 74.656 67.54 77.062 67.34 79.543L29.806 79.543C24.655 79.543 20.48 75.368 20.48 70.217L20.48 37.577C20.48 32.427 24.655 28.251 29.806 28.251Z" fill-rule="evenodd" fill="currentColor" opacity="0.7"/>
<path d="M46.514 85.76L67.612 85.76C68.236 88.656 69.555 91.309 71.347 93.641C70.684 94.064 69.896 94.309 69.051 94.309L46.514 94.309C44.154 94.309 42.24 92.395 42.24 90.034C42.24 87.674 44.154 85.76 46.514 85.76Z" fill-rule="evenodd" fill="currentColor" opacity="0.45"/>
<circle cx="88.869" cy="81.097" r="18.651" fill="currentColor"/>`

// SVG is the icon as an SVG file. The idle one uses KDE's ColorScheme-Text class, so
// Plasma paints it in the panel's text colour, light or dark.
func SVG(i Icon) string {
	c := iconColor[i]
	style, class := "", ""
	if i == IconIdle {
		style = fmt.Sprintf(`<style id="current-color-scheme">.ColorScheme-Text{color:#%02x%02x%02x;}</style>`, c.R, c.G, c.B)
		class = ` class="ColorScheme-Text"`
	}
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 92 92" width="22" height="22">%s<g%s style="color:#%02x%02x%02x">%s</g></svg>`+"\n",
		style, class, c.R, c.G, c.B, glyph)
}

// AppIcon is the full app icon (apps/web/public/icon.svg): the white glyph on the olive
// rounded square, for the launcher and the notifications.
func AppIcon() string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="512" height="512">` +
		`<rect width="128" height="128" rx="28" fill="#5b7a3a"/>` +
		`<g transform="translate(0.154 0.154) scale(0.99759)" style="color:#fff">` + glyph + "</g></svg>\n"
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
	// The glyph's ink spans x 20.5–107.5 and y 28.3–99.7: fit a 92-unit box around its centre.
	const span, ox, oy = 92.0, 64.0, 64.0
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

// Geometry of the glyph, as in glyph (128 space): the monitor and the stand are rounded
// rectangles with a circular knock-out around the live circle in front.
const (
	liveX, liveY, liveR = 88.869, 81.097, 18.651
	knockR              = 21.69 // the live circle plus its gap
)

// coverage is how much of a pixel of width unit centred on (x, y) the glyph covers.
func coverage(x, y, unit float64) float64 {
	ink := func(d float64) float64 { return clamp(0.5 - d/unit) }
	dLive := math.Hypot(x-liveX, y-liveY)
	cut := knockR - dLive // positive inside the knock-out, so it is outside the shapes
	a := ink(dLive - liveR)
	monitor := math.Max(roundRect(x, y, 20.48, 28.251, 74.606, 51.292, 9.326), cut)
	stand := math.Max(roundRect(x, y, 42.24, 85.76, 30, 8.549, 4.2745), cut)
	a = math.Max(a, 0.7*ink(monitor))
	a = math.Max(a, 0.45*ink(stand))
	return a
}

// roundRect is the signed distance to a rounded rectangle (negative inside).
func roundRect(x, y, rx, ry, w, h, r float64) float64 {
	cx, cy := rx+w/2, ry+h/2
	qx := math.Abs(x-cx) - (w/2 - r)
	qy := math.Abs(y-cy) - (h/2 - r)
	return math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - r
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
