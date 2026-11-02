// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package audio

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strconv"
	"testing"
	"time"
)

// TestPWCapture links a capture node to the first app playing audio, reads PCM for 3 s
// and checks that only that app is linked in: go test -tags integration ./internal/audio/
func TestPWCapture(t *testing.T) {
	ctx := context.Background()
	apps, err := ListApps(ctx)
	if err != nil || len(apps) == 0 {
		t.Skipf("no app playing audio (%v)", err)
	}
	app := apps[0]
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	c, err := StartPW(ctx, Selector{Name: app.Name}, log)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Stop() }()
	if c.Linked() == 0 {
		t.Fatalf("%s not linked", app.Name)
	}
	n := make(chan int64, 1)
	go func() {
		got, _ := io.Copy(io.Discard, io.LimitReader(c.PCM(), 1<<30))
		n <- got
	}()
	time.Sleep(3 * time.Second)

	g, err := dump(ctx)
	if err != nil {
		t.Fatal(err)
	}
	node, ok := g.NodeByName("openlive-helper-audio-" + itoa(os.Getpid()))
	if !ok {
		t.Fatal("capture node gone")
	}
	if plan := g.PlanCapture(node.ID, Selector{Name: app.Name}); !plan.Empty() {
		t.Errorf("graph not as planned: %+v", plan)
	}
	ins := map[uint32]bool{}
	for _, p := range g.PortsOf(node.ID, false) {
		ins[p.ID] = true
	}
	appPorts := map[uint32]bool{}
	for _, src := range g.Sources(Selector{Name: app.Name}) {
		for _, p := range g.PortsOf(src.ID, true) {
			appPorts[p.ID] = true
		}
	}
	for _, l := range g.Links {
		if ins[l.In] {
			t.Logf("link %d: %d -> %d (app port: %v)", l.ID, l.Out, l.In, appPorts[l.Out])
			if !appPorts[l.Out] {
				t.Errorf("foreign link into the capture node: %+v", l)
			}
		}
	}
	_ = c.Stop()
	t.Logf("%s: %d bytes of PCM in ~3 s (%d expected while it plays)", app.Name, <-n, 3*SampleRate*Channels*2)
	g, _ = dump(ctx)
	if _, ok := g.NodeByName("openlive-helper-audio-" + itoa(os.Getpid())); ok {
		t.Error("capture node still there after Stop")
	}
}

func itoa(i int) string { return strconv.Itoa(i) }
