// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package hotkeys

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// TestBind needs a desktop with the GlobalShortcuts portal (KDE Plasma 6):
//
//	go test -tags integration -run TestBind -v ./internal/hotkeys/
//
// The first run shows KDE's shortcut dialog: accept it. With OPENLIVE_PRESS=1 the test
// then waits 30 s for the curtain shortcut (Ctrl+Alt+Shift+H) to be pressed.
func TestBind(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	bindings, err := Parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	s, err := Bind(ctx, bindings, Options{AppID: "dev.hfps.OpenliveHelper", Describe: func(a Action) string { return "Openlive test: " + string(a) }})
	if errors.Is(err, ErrUnavailable) {
		t.Skip(err)
	}
	if err != nil && strings.Contains(err.Error(), "app id") {
		t.Skipf("%v: KDE needs dev.hfps.OpenliveHelper.desktop; run openlive-helper run once to write it", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, b := range s.Bound {
		t.Logf("bound %s = %q", b.Action, b.Trigger)
	}
	if len(s.Bound) == 0 {
		t.Fatal("nothing bound")
	}
	if os.Getenv("OPENLIVE_PRESS") == "" {
		return
	}
	t.Log("press Ctrl+Alt+Shift+H now")
	select {
	case a := <-s.Activated():
		if a != Curtain {
			t.Fatalf("pressed %s", a)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("no press within 30 s")
	}
}
