// SPDX-License-Identifier: AGPL-3.0-only

package media

import (
	"slices"
	"sync"
	"testing"
	"time"
)

func TestBitrateGate(t *testing.T) {
	var mu sync.Mutex
	var got []int
	g := newBitrateGate(100*time.Millisecond, 8000, func(kbps int) {
		mu.Lock()
		got = append(got, kbps)
		mu.Unlock()
	})
	applied := func() []int {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(got)
	}
	g.set(8000) // the start value: nothing to do
	g.set(6000) // the first change applies at once
	g.set(5000) // within the gap: waits…
	g.set(4000) // …and only the latest is applied
	if a := applied(); !slices.Equal(a, []int{6000}) {
		t.Fatalf("applied %v, want [6000] before the gap ends", a)
	}
	time.Sleep(200 * time.Millisecond)
	if a := applied(); !slices.Equal(a, []int{6000, 4000}) {
		t.Fatalf("applied %v, want [6000 4000]", a)
	}
	time.Sleep(150 * time.Millisecond)
	g.set(7000) // the gap has passed: at once
	g.set(4000) // within the gap again: waits
	g.close()
	time.Sleep(150 * time.Millisecond)
	if a := applied(); !slices.Equal(a, []int{6000, 4000, 7000}) {
		t.Fatalf("applied %v, want [6000 4000 7000] (the waiting change dropped by close)", a)
	}
}
