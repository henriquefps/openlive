// SPDX-License-Identifier: AGPL-3.0-only

package overlay

import (
	"errors"
	"sync"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Spec is one ping to draw.
type Spec struct {
	Point Point
	Name  string
	Style protocol.PointerStyle
}

// Drawer shows pings on the desktop until closed.
type Drawer interface {
	// Show starts one ping's animation; it does not wait for it. An error means the drawer
	// is gone (the compositor dropped the connection) and should be opened again.
	Show(Spec) error
	Close()
}

// Support is what Probe found.
type Support struct {
	// Wayland: the helper reached a Wayland compositor.
	Wayland bool
	// LayerShell: the compositor offers zwlr_layer_shell_v1, which the overlay needs.
	LayerShell bool
	// Viewporter: fractional scales are drawn at the output's pixels (else rounded up to
	// a whole scale).
	Viewporter bool
	// Err says why there is no overlay, nil when there is one.
	Err error
}

// OK is true when pings can be drawn.
func (s Support) OK() bool { return s.Wayland && s.LayerShell && s.Err == nil }

// ErrNoLayerShell means the compositor is Wayland without the wlr layer shell (GNOME).
var ErrNoLayerShell = errors.New("the compositor has no wlr layer shell (zwlr_layer_shell_v1)")

var supported = sync.OnceValue(func() bool { return Probe().OK() })

// Supported is Probe().OK(), asked once per process: what stream.announce says as
// pingOverlay (PROTOCOL.md §7.9).
func Supported() bool { return supported() }
