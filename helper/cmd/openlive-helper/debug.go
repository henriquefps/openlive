// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/henriquefps/openlive/helper/internal/compositor"
	"github.com/henriquefps/openlive/helper/internal/overlay"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// runDebug holds developer commands that try one piece of the helper on the real desktop.
func runDebug(args []string, w io.Writer) error {
	if len(args) == 0 || args[0] != "ping" {
		return errors.New("usage: openlive-helper debug ping [--x 0.5] [--y 0.5] [--name Test] [--color olive] [--shape ring] [--output NAME] [--count 1]")
	}
	return runDebugPing(args[1:], w)
}

// runDebugPing draws pointer pings on a monitor as a viewer's click would (PROTOCOL.md
// §7.9), without a room or a stream.
func runDebugPing(args []string, w io.Writer) error {
	fs := flag.NewFlagSet("debug ping", flag.ContinueOnError)
	x := fs.Float64("x", 0.5, "horizontal position, 0 to 1 over the monitor")
	y := fs.Float64("y", 0.5, "vertical position, 0 to 1 over the monitor")
	name := fs.String("name", "Test", "the viewer's name in the pill")
	col := fs.String("color", string(protocol.PointerColorOlive), "pointer color (olive, red, orange, yellow, green, cyan, blue, purple, pink, white)")
	shape := fs.String("shape", string(protocol.PointerShapeRing), "pointer shape (ring, dot, crosshair, star)")
	output := fs.String("output", "", "monitor name (default: the first one KWin lists)")
	count := fs.Int("count", 1, "pings at once: the others go around the first with every color and shape")
	hold := fs.Duration("hold", 0, "keep the connection this long after the last ping (to try clicking through it)")
	verbose := fs.Bool("v", false, "verbose logs")
	if err := fs.Parse(args); err != nil {
		return err
	}
	lvl := slog.LevelInfo
	if *verbose {
		lvl = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl}))

	sup := overlay.Probe()
	_, _ = fmt.Fprintf(w, "overlay: %s\n", overlayVerdict(sup))
	if !sup.OK() {
		return errors.New("no overlay on this desktop")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	// Its own script name: the default one belongs to a helper that may be streaming.
	kw, err := compositor.WatchKWinAs(ctx, "openlive-helper-debug-ping")
	cancel()
	if err != nil {
		return fmt.Errorf("the monitors' geometry comes from KWin: %w", err)
	}
	snap := kw.Snapshot()
	kw.Close()
	var out compositor.Output
	for _, o := range snap.Outputs {
		if *output == "" || o.Name == *output {
			out = o
			break
		}
	}
	if out.Name == "" {
		return fmt.Errorf("no monitor %q", *output)
	}
	_, _ = fmt.Fprintf(w, "monitor: %s at %d,%d, %dx%d logical, scale %g\n", out.Name, out.X, out.Y, out.Width, out.Height, out.Scale)

	d, err := overlay.Open(log)
	if err != nil {
		return err
	}
	defer d.Close()
	src := overlay.Source{FrameW: out.Width, FrameH: out.Height, Output: out.Name}
	for i := range max(1, *count) {
		px, py := *x, *y
		style := protocol.PointerStyle{Color: protocol.PointerColor(*col), Shape: protocol.PointerShape(*shape)}
		who := *name
		if i > 0 {
			// Around the first ping, one step of 120 logical pixels per ping.
			px += float64((i%4)-1) * 120 / float64(out.Width) * float64(1+i/4)
			py += float64(((i+1)%3)-1) * 90 / float64(out.Height)
			style.Color = protocol.PointerColorValues[i%len(protocol.PointerColorValues)]
			style.Shape = protocol.PointerShapeValues[i%len(protocol.PointerShapeValues)]
			who = fmt.Sprintf("%s %d", *name, i+1)
		}
		pt, err := overlay.Map(src, snap, px, py)
		if err != nil {
			_, _ = fmt.Fprintf(w, "ping %d at %.3f,%.3f: %v\n", i+1, px, py, err)
			continue
		}
		if err := d.Show(overlay.Spec{Point: pt, Name: who, Style: style}); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(w, "ping %d: %s %s %q at %.0f,%.0f on %s\n", i+1, style.Color, style.Shape, who, pt.X, pt.Y, pt.Output.Name)
	}
	time.Sleep(overlay.Duration + 300*time.Millisecond + *hold)
	return nil
}

// overlayVerdict is the doctor's line about the pointer ping overlay (PROTOCOL.md §7.9).
func overlayVerdict(s overlay.Support) string {
	switch {
	case s.OK():
		return fmt.Sprintf("yes (Wayland, layer-shell yes, viewporter %s)", yesNo(s.Viewporter))
	case s.Wayland && !s.LayerShell:
		return "no (Wayland, layer-shell no): viewers cannot ping this helper's streams"
	default:
		return fmt.Sprintf("no (%v): viewers cannot ping this helper's streams", s.Err)
	}
}
