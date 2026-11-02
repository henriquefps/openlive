// SPDX-License-Identifier: AGPL-3.0-only

package media

import "context"

// The source types are shared by the capture backends and the hub
// client that lists them to the web (helper.listSources, PROTOCOL.md §8.2). Keep this
// file small: it is the contract between the two.

// SourceKind says what a Source captures.
type SourceKind string

const (
	SourceScreen SourceKind = "screen"
	SourceWindow SourceKind = "window"
	SourceTest   SourceKind = "test"
)

// On Wayland the xdg-desktop-portal shows its own picker, so a backend cannot list the
// screens and windows. It lists one pseudo-source per kind instead; starting one always
// opens the system dialog. The portal can restore an earlier choice without
// the dialog: those are listed apart ("Last: <label>"), so the choice stays explicit.
const (
	PortalScreenID = "portal:screen"
	PortalWindowID = "portal:window"
	// PortalLastScreenID and PortalLastWindowID restore the last screen or window shared.
	PortalLastScreenID = "portal:screen:last"
	PortalLastWindowID = "portal:window:last"
)

// Source is something a backend can capture.
type Source struct {
	// ID is stable for as long as the source exists (at most 128 characters).
	ID    string
	Kind  SourceKind
	Label string
	// AppName is the application of a window; empty for screens.
	AppName string
	// Width and Height are the source's size in pixels, 0 when unknown.
	Width  int
	Height int
	// HasAudio: the application's own audio can be captured with this source.
	HasAudio bool
	// Restored: a source the portal granted before, restorable without the dialog.
	Restored bool
}

// AudioApp is the app whose audio a stream captures (a shared window's app).
type AudioApp struct {
	// Name is the window's class or app id, else the name the app was chosen by.
	Name string
	// Binary is the process's command name, PID its process (0 when unknown).
	Binary string
	PID    int
}

// IsPortalPicker reports whether starting the source opens the system's picker.
func (s Source) IsPortalPicker() bool {
	return s.ID == PortalScreenID || s.ID == PortalWindowID
}

// IsPortalLast reports whether the source restores the last shared screen or window.
func (s Source) IsPortalLast() bool {
	return s.ID == PortalLastScreenID || s.ID == PortalLastWindowID
}

// Thumbnail is a still of a source for the web's source picker. It is sent to the
// user's own web session only and never stored.
type Thumbnail struct {
	// MimeType is image/jpeg or image/webp.
	MimeType string
	Width    int
	Height   int
	Data     []byte
}

// Thumbnailer is implemented by backends that can grab a still of a source. The image
// fits in maxWidth × maxHeight.
type Thumbnailer interface {
	Thumbnail(ctx context.Context, src Source, maxWidth, maxHeight int) (Thumbnail, error)
}
