// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package compositor

import (
	"context"
	"testing"
	"time"
)

// TestKWinWatch needs a Plasma 6 session: go test -tags integration ./internal/compositor/
func TestKWinWatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// A separate plugin name keeps a running helper service's script untouched.
	k, err := watchKWin(ctx, "openlive-helper-itest")
	if err != nil {
		t.Skipf("no KWin: %v", err)
	}
	defer k.Close()
	s := k.Snapshot()
	if len(s.Outputs) == 0 {
		t.Fatalf("no outputs in %+v", s)
	}
	for _, o := range s.Outputs {
		t.Logf("output %+v", o)
	}
	for _, w := range s.Windows {
		t.Logf("window %+v", w)
	}
}
