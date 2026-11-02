// SPDX-License-Identifier: AGPL-3.0-only

package overlay

import (
	"log/slog"
	"sync"

	"github.com/henriquefps/openlive/helper/internal/compositor"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Target is a stream whose pings can be mapped back to the desktop (the Linux capture).
type Target interface {
	// PingSource is what the video frame shows now and the compositor's latest state;
	// false when the stream cannot place a ping (no compositor to ask).
	PingSource() (Source, compositor.Snapshot, bool)
	// Paused is true while the curtain or a pause hides the source.
	Paused() (bool, string)
}

// Controller draws one live stream's pings: it holds a drawer while the stream allows pings
// and drops pings while the stream is paused (PROTOCOL.md §7.9).
type Controller struct {
	log *slog.Logger
	// open makes the drawer; Open by default.
	open func(*slog.Logger) (Drawer, error)
	// target is the current capture (a preset switch replaces it).
	target func() (Target, bool)

	mu      sync.Mutex
	enabled bool
	drawer  Drawer
}

// NewController draws pings of the stream target returns.
func NewController(log *slog.Logger, target func() (Target, bool)) *Controller {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Controller{log: log, open: Open, target: target}
}

// WithOpener replaces how the drawer is made (tests).
func (c *Controller) WithOpener(open func(*slog.Logger) (Drawer, error)) *Controller {
	c.open = open
	return c
}

// SetEnabled follows StreamInfo.pings: the drawer is opened while it is true and closed
// when it turns false, so the helper keeps no compositor connection for a stream that
// does not allow pings.
func (c *Controller) SetEnabled(on bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if on == c.enabled {
		return
	}
	c.enabled = on
	c.log.Info("pointer pings", "allowed", on)
	if !on {
		c.closeLocked()
		return
	}
	c.openLocked()
}

func (c *Controller) openLocked() bool {
	if c.drawer != nil {
		return true
	}
	d, err := c.open(c.log)
	if err != nil {
		c.log.Warn("pointer pings: no overlay", "err", err)
		return false
	}
	c.drawer = d
	return true
}

func (c *Controller) closeLocked() {
	if c.drawer != nil {
		c.drawer.Close()
		c.drawer = nil
	}
}

// Ping draws one ping. It reports whether the ping was shown; a dropped one is logged at
// debug level only, since the room already checked who may ping.
func (c *Controller) Ping(p protocol.PointerPingedPayload) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.enabled {
		c.log.Debug("pointer ping dropped: pings are off", "from", p.UserID)
		return false
	}
	t, ok := c.target()
	if !ok {
		return false
	}
	if paused, _ := t.Paused(); paused {
		// The room drops them too; the curtain goes down here first (PROTOCOL.md §7.9).
		c.log.Debug("pointer ping dropped: the stream is paused", "from", p.UserID)
		return false
	}
	src, snap, ok := t.PingSource()
	if !ok {
		c.log.Debug("pointer ping dropped: the stream cannot place pings", "from", p.UserID)
		return false
	}
	pt, err := Map(src, snap, p.X, p.Y)
	if err != nil {
		c.log.Debug("pointer ping dropped", "from", p.UserID, "reason", err)
		return false
	}
	if !c.openLocked() {
		return false
	}
	spec := Spec{Point: pt, Name: p.Name, Style: p.Style}
	if err := c.drawer.Show(spec); err != nil {
		// The compositor dropped the connection: open a new one once.
		c.log.Warn("pointer pings: overlay lost, reconnecting", "err", err)
		c.closeLocked()
		if !c.openLocked() || c.drawer.Show(spec) != nil {
			return false
		}
	}
	return true
}

// Close removes every ping and the compositor connection (the stream ended).
func (c *Controller) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.enabled = false
	c.closeLocked()
}
