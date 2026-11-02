// SPDX-License-Identifier: AGPL-3.0-only

// Package thumbnail sends the stream's card snapshot: a
// small JPEG every 10 s while live, so the room's cards show the stream without pulling
// video. The frames come from the encoder input (a low-priority branch of the capture
// pipeline that never stalls the encoders, internal/media); this package decides when to
// send what, keeps each image under the size limit, and sends it.
//
// Nothing of the screen leaves during a pause or the privacy curtain: the runner sends one
// "paused" placeholder instead, and no snapshot until the stream resumes.
package thumbnail

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"log/slog"
	"sync"
	"time"
)

const (
	// Interval is the time between two snapshots while live.
	Interval = 10 * time.Second
	// ResumeDelay is the wait for the first snapshot after a pause: the encoder input
	// shows the source again only once the curtain's black frames are gone.
	ResumeDelay = 2 * time.Second
	// MaxBytes is the size the helper keeps each image under; the Worker takes up to
	// 64 KiB (docs/PROTOCOL.md §11.3).
	MaxBytes = 30 * 1024
	// Width is the snapshot's width in pixels; the height follows the stream's aspect.
	Width = 320
	// tick is how often the runner asks the policy.
	tick = time.Second
	// uploadTimeout bounds one upload.
	uploadTimeout = 8 * time.Second
)

// Action is what the policy wants sent now.
type Action int

const (
	Wait Action = iota
	Snapshot
	Placeholder
)

// Policy decides, once per tick, what to send. It holds no clock: callers pass the time.
type Policy struct {
	interval time.Duration
	paused   bool
	// placeholderDue is set when a pause starts and cleared once the placeholder went.
	placeholderDue bool
	// next is the earliest time anything is sent; zero means now.
	next time.Time
}

// NewPolicy starts live, with the first snapshot due at once.
func NewPolicy(interval time.Duration) *Policy { return &Policy{interval: interval} }

// SetPaused reports a pause (the curtain, a hidden source) or a resume.
func (p *Policy) SetPaused(paused bool, now time.Time) {
	if paused == p.paused {
		return
	}
	p.paused = paused
	p.placeholderDue = paused
	if paused {
		p.next = time.Time{}
	} else {
		p.next = now.Add(ResumeDelay)
	}
}

// Next is what to send now: a snapshot every interval while live; while paused, the
// placeholder once and then nothing.
func (p *Policy) Next(now time.Time) Action {
	if now.Before(p.next) {
		return Wait
	}
	if p.paused {
		if p.placeholderDue {
			return Placeholder
		}
		return Wait
	}
	return Snapshot
}

// Done records the outcome of the action Next returned. Success or failure, the next
// attempt waits a full interval (a failing instance is never hammered); a refused
// placeholder is not tried again.
func (p *Policy) Done(a Action, now time.Time, err error) {
	switch a {
	case Snapshot:
		p.next = now.Add(p.interval)
	case Placeholder:
		if err == nil || !Retryable(err) {
			p.placeholderDue = false
		}
		p.next = now.Add(p.interval)
	}
}

// Retryable tells a transient upload failure (network, 5xx, rate limit) from a refusal.
// The uploader marks refusals with ErrRefused.
func Retryable(err error) bool { return !errors.Is(err, ErrRefused) }

// ErrRefused wraps an answer that sending the same thing again will not change (4xx).
var ErrRefused = errors.New("thumbnail refused")

// Source is the latest snapshot of the encoder input, as JPEG; ok is false while there
// is none (the capture just started, or the backend has no snapshot branch).
type Source interface {
	Snapshot() (jpeg []byte, ok bool)
}

// Upload sends one image; placeholder marks the paused frame.
type Upload func(ctx context.Context, jpeg []byte, placeholder bool) error

// Runner follows a live stream and sends its thumbnails until stopped.
type Runner struct {
	source Source
	upload Upload
	log    *slog.Logger

	mu     sync.Mutex
	policy *Policy
	// placeholder is the paused frame, sized like the snapshots.
	placeholder []byte

	stop chan struct{}
	done chan struct{}
	once sync.Once
}

// Start begins sending; Stop ends it. width and height are the stream's output size,
// which sizes the placeholder like the snapshots.
func Start(source Source, upload Upload, width, height int, log *slog.Logger) *Runner {
	r := &Runner{
		source: source, upload: upload, log: log,
		policy:      NewPolicy(Interval),
		placeholder: PausedFrame(Width, HeightFor(width, height)),
		stop:        make(chan struct{}),
		done:        make(chan struct{}),
	}
	go r.run()
	return r
}

// SetPaused follows the stream's pause and curtain. It takes effect before the next tick,
// so no snapshot taken after this call is sent while paused.
func (r *Runner) SetPaused(paused bool) {
	r.mu.Lock()
	r.policy.SetPaused(paused, time.Now())
	r.mu.Unlock()
}

// Stop ends the runner and waits for an upload in flight.
func (r *Runner) Stop() {
	r.once.Do(func() { close(r.stop) })
	<-r.done
}

func (r *Runner) run() {
	defer close(r.done)
	t := time.NewTicker(tick)
	defer t.Stop()
	warned := false
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
		}
		now := time.Now()
		r.mu.Lock()
		action := r.policy.Next(now)
		r.mu.Unlock()
		var data []byte
		switch action {
		case Wait:
			continue
		case Placeholder:
			data = r.placeholder
		case Snapshot:
			snap, ok := r.source.Snapshot()
			if !ok {
				continue // no frame yet: ask again next tick
			}
			fitted, err := Fit(snap, MaxBytes)
			if err != nil {
				r.log.Debug("thumbnail too large, skipped", "bytes", len(snap), "err", err)
				r.done1(action, now, nil)
				continue
			}
			data = fitted
		}
		// The pause may have started while the snapshot was taken: check again.
		r.mu.Lock()
		stale := action == Snapshot && r.policy.Next(now) != Snapshot
		r.mu.Unlock()
		if stale {
			continue
		}
		err := r.send(data, action == Placeholder)
		if err != nil && !warned {
			r.log.Warn("thumbnail upload failed (the card shows no preview)", "err", err)
			warned = true
		} else if err == nil {
			warned = false
		}
		r.done1(action, now, err)
	}
}

func (r *Runner) done1(a Action, now time.Time, err error) {
	r.mu.Lock()
	r.policy.Done(a, now, err)
	r.mu.Unlock()
}

func (r *Runner) send(data []byte, placeholder bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), uploadTimeout)
	defer cancel()
	go func() {
		select {
		case <-r.stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	return r.upload(ctx, data, placeholder)
}

// HeightFor is the snapshot height for a width×height output: Width wide, same aspect,
// even, at least 2.
func HeightFor(width, height int) int {
	if width <= 0 || height <= 0 {
		return Width * 9 / 16
	}
	return max(2, (Width*height/width)&^1)
}

// Fit returns img if it is at most limit bytes, else re-encodes it at lower quality and,
// if needed, at half the size. The pipeline's JPEG is ~10 KB at 320 px, so this is rare
// (noisy content).
func Fit(img []byte, limit int) ([]byte, error) {
	if len(img) <= limit {
		return img, nil
	}
	decoded, err := jpeg.Decode(bytes.NewReader(img))
	if err != nil {
		return nil, err
	}
	for _, src := range []image.Image{decoded, half(decoded)} {
		for _, q := range []int{50, 35} {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: q}); err != nil {
				return nil, err
			}
			if buf.Len() <= limit {
				return buf.Bytes(), nil
			}
		}
	}
	return nil, errors.New("still over the limit at quality 35 and half size")
}

// half scales an image to half its size (box filter over 2×2 pixels).
func half(src image.Image) image.Image {
	b := src.Bounds()
	w, h := max(1, b.Dx()/2), max(1, b.Dy()/2)
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			var r, g, bl uint32
			for _, d := range [4][2]int{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
				cr, cg, cb, _ := src.At(b.Min.X+2*x+d[0], b.Min.Y+2*y+d[1]).RGBA()
				r, g, bl = r+cr, g+cg, bl+cb
			}
			out.SetRGBA(x, y, color.RGBA{uint8(r / 4 >> 8), uint8(g / 4 >> 8), uint8(bl / 4 >> 8), 255})
		}
	}
	return out
}

// PausedFrame is the placeholder sent while the stream is paused: a dark frame with a
// pause sign (two bars), drawn without fonts so it needs no translation.
func PausedFrame(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	bg := color.RGBA{0x18, 0x18, 0x1b, 0xff}
	fg := color.RGBA{0xa1, 0xa1, 0xaa, 0xff}
	barW, barH := max(2, w/24), max(4, h/4)
	gap := barW
	left := (w - 2*barW - gap) / 2
	top := (h - barH) / 2
	for y := range h {
		for x := range w {
			c := bg
			inBar := (x >= left && x < left+barW) || (x >= left+barW+gap && x < left+2*barW+gap)
			if inBar && y >= top && y < top+barH {
				c = fg
			}
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 70})
	return buf.Bytes()
}
