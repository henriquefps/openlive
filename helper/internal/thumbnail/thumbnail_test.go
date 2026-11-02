// SPDX-License-Identifier: AGPL-3.0-only

package thumbnail

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"math/rand/v2"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)

func TestPolicySnapshotEveryInterval(t *testing.T) {
	p := NewPolicy(Interval)
	if got := p.Next(t0); got != Snapshot {
		t.Fatalf("first tick: %v, want a snapshot at once", got)
	}
	p.Done(Snapshot, t0, nil)
	for _, d := range []time.Duration{time.Second, 5 * time.Second, Interval - time.Millisecond} {
		if got := p.Next(t0.Add(d)); got != Wait {
			t.Fatalf("after %v: %v, want wait", d, got)
		}
	}
	if got := p.Next(t0.Add(Interval)); got != Snapshot {
		t.Fatalf("after the interval: %v, want a snapshot", got)
	}
	// A failed upload also waits a full interval.
	p.Done(Snapshot, t0.Add(Interval), errors.New("network"))
	if got := p.Next(t0.Add(Interval + time.Second)); got != Wait {
		t.Fatalf("after a failure: %v, want wait", got)
	}
}

func TestPolicyPausedSendsOnePlaceholderAndNoSnapshot(t *testing.T) {
	p := NewPolicy(Interval)
	p.Done(Snapshot, t0, nil)
	p.SetPaused(true, t0.Add(time.Second))
	// The placeholder goes at once, even inside the snapshot interval.
	if got := p.Next(t0.Add(time.Second)); got != Placeholder {
		t.Fatalf("on pause: %v, want the placeholder", got)
	}
	p.Done(Placeholder, t0.Add(time.Second), nil)
	for d := 2 * time.Second; d < 2*time.Minute; d += time.Second {
		if got := p.Next(t0.Add(d)); got != Wait {
			t.Fatalf("paused, after %v: %v, want nothing", d, got)
		}
	}
	// Resume: a snapshot shortly after, not the stale one.
	resume := t0.Add(2 * time.Minute)
	p.SetPaused(false, resume)
	if got := p.Next(resume); got != Wait {
		t.Fatalf("right at resume: %v, want wait", got)
	}
	if got := p.Next(resume.Add(ResumeDelay)); got != Snapshot {
		t.Fatalf("after the resume delay: %v, want a snapshot", got)
	}
}

func TestPolicyPlaceholderRetriedOnlyWhenTransient(t *testing.T) {
	p := NewPolicy(Interval)
	p.SetPaused(true, t0)
	p.Done(Placeholder, t0, errors.New("network"))
	if got := p.Next(t0.Add(Interval)); got != Placeholder {
		t.Fatalf("after a network error: %v, want the placeholder again", got)
	}
	p.Done(Placeholder, t0.Add(Interval), fmt.Errorf("%w: 409", ErrRefused))
	if got := p.Next(t0.Add(3 * Interval)); got != Wait {
		t.Fatalf("after a refusal: %v, want nothing", got)
	}
	// Pausing twice does not send a second placeholder.
	p.SetPaused(true, t0.Add(4*Interval))
	if got := p.Next(t0.Add(5 * Interval)); got != Wait {
		t.Fatalf("second pause report: %v, want nothing", got)
	}
}

func TestHeightFor(t *testing.T) {
	for _, c := range []struct{ w, h, want int }{
		{1920, 1080, 180}, {2560, 1440, 180}, {1280, 1024, 256}, {3440, 1440, 132}, {0, 0, 180},
	} {
		if got := HeightFor(c.w, c.h); got != c.want {
			t.Errorf("HeightFor(%d, %d) = %d, want %d", c.w, c.h, got, c.want)
		}
	}
}

func TestPausedFrameIsASmallJPEG(t *testing.T) {
	data := PausedFrame(Width, 180)
	if len(data) == 0 || len(data) > MaxBytes {
		t.Fatalf("placeholder is %d bytes", len(data))
	}
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != Width || b.Dy() != 180 {
		t.Fatalf("placeholder is %v", b)
	}
}

func noise(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	r := rand.New(rand.NewPCG(1, 2))
	for y := range h {
		for x := range w {
			img.SetRGBA(x, y, color.RGBA{uint8(r.IntN(256)), uint8(r.IntN(256)), uint8(r.IntN(256)), 255})
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95})
	return buf.Bytes()
}

func TestFitKeepsSmallImagesAndShrinksLargeOnes(t *testing.T) {
	small := PausedFrame(Width, 180)
	if got, err := Fit(small, MaxBytes); err != nil || !bytes.Equal(got, small) {
		t.Fatalf("a small image must pass as is (err %v)", err)
	}
	big := noise(Width, 180)
	if len(big) <= MaxBytes {
		t.Fatalf("test image is only %d bytes", len(big))
	}
	got, err := Fit(big, MaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) > MaxBytes {
		t.Fatalf("fitted image is %d bytes", len(got))
	}
	if _, err := jpeg.Decode(bytes.NewReader(got)); err != nil {
		t.Fatal(err)
	}
	if _, err := Fit(big, 100); err == nil {
		t.Fatal("an impossible limit must fail")
	}
}

type fakeSource struct {
	mu    sync.Mutex
	frame []byte
	taken int
}

func (f *fakeSource) Snapshot() ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.taken++
	return f.frame, f.frame != nil
}

type sent struct {
	data        []byte
	placeholder bool
}

func TestRunnerSendsSnapshotsThenThePlaceholder(t *testing.T) {
	if testing.Short() {
		t.Skip("runs on the real clock for a few seconds")
	}
	src := &fakeSource{frame: PausedFrame(Width, 180)}
	var mu sync.Mutex
	var uploads []sent
	r := Start(src, func(_ context.Context, data []byte, placeholder bool) error {
		mu.Lock()
		uploads = append(uploads, sent{data, placeholder})
		mu.Unlock()
		return nil
	}, 1920, 1080, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer r.Stop()
	wait := func(n int) []sent {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			got := append([]sent(nil), uploads...)
			mu.Unlock()
			if len(got) >= n {
				return got
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %d uploads", n)
		return nil
	}
	if got := wait(1); got[0].placeholder {
		t.Fatal("the first upload must be a snapshot")
	}
	r.SetPaused(true)
	got := wait(2)
	if !got[1].placeholder {
		t.Fatal("the pause must send the placeholder")
	}
	// Nothing else while paused, however many ticks pass.
	time.Sleep(2500 * time.Millisecond)
	mu.Lock()
	n := len(uploads)
	mu.Unlock()
	if n != 2 {
		t.Fatalf("%d uploads while paused, want 2", n)
	}
}
