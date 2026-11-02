// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package tray

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// TestTrayOverDBus needs a session bus: go test -tags integration ./internal/tray/
// With a tray host (Plasma) the icon shows for a moment.
func TestTrayOverDBus(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	actions := make(chan Action, 4)
	live := Status{Online: true, Instance: "https://openlive.example", State: protocol.HelperStateLive, Room: "Games", Preset: "1080p60"}
	tr, err := Start(ctx, live, Options{Catalog: en, ThemeDir: t.TempDir(), OnAction: func(a Action) { actions <- a }})
	if err != nil && !errors.Is(err, ErrNoHost) {
		t.Skipf("no session bus: %v", err)
	}
	if err := WriteTheme(tr.opts.ThemeDir); err != nil {
		t.Fatal(err)
	}
	t.Logf("hosted: %v", tr.Hosted())

	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	menu := conn.Object(tr.name, menuPath)
	var rev uint32
	var root layout
	if err := menu.Call(menuIface+".GetLayout", 0, int32(0), int32(-1), []string{}).Store(&rev, &root); err != nil {
		t.Fatal(err)
	}
	if len(root.Children) != len(Menu(live, en)) {
		t.Fatalf("layout has %d children", len(root.Children))
	}
	if err := menu.Call(menuIface+".Event", 0, idCurtain, "clicked", dbus.MakeVariant(""), uint32(0)).Err; err != nil {
		t.Fatal(err)
	}
	select {
	case a := <-actions:
		if a != CurtainOn {
			t.Fatalf("action %s", a)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no action")
	}
	v, err := conn.Object(tr.name, itemPath).GetProperty(itemIface + ".IconName")
	if err != nil || v.Value() != IconName(IconLive) {
		t.Fatalf("IconName %v %v", v, err)
	}
	tr.Update(Status{Online: true, Instance: "https://openlive.example", State: protocol.HelperStateIdle})
	v, _ = conn.Object(tr.name, itemPath).GetProperty(itemIface + ".IconName")
	if v.Value() != IconName(IconIdle) {
		t.Fatalf("IconName after update %v", v)
	}
	time.Sleep(time.Second)
}
