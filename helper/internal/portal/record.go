// SPDX-License-Identifier: AGPL-3.0-only

package portal

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Choice identifies what the person picked in the dialog, as far as the desktop lets the
// helper tell: the output's name and geometry for a monitor, the window's application
// and caption for a window. Fields that could not be found stay empty.
type Choice struct {
	Kind Kind `json:"kind"`
	// Monitor.
	Output string `json:"output,omitempty"`
	X      int    `json:"x,omitempty"`
	Y      int    `json:"y,omitempty"`
	// Width and Height of the output or window, in pixels.
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
	// Window.
	WindowClass   string `json:"windowClass,omitempty"`
	WindowCaption string `json:"windowCaption,omitempty"`
}

// Source is the choice as the UI shows it.
func (c Choice) Source() Source {
	label := c.Output
	if c.Kind == KindWindow {
		label = c.WindowCaption
		if label == "" {
			label = c.WindowClass
		}
	}
	if label == "" {
		label = "Unknown " + c.Kind.String()
		if c.Width > 0 && c.Height > 0 {
			label = fmt.Sprintf("%s %dx%d", label, c.Width, c.Height)
		}
	}
	return Source{Kind: c.Kind, Label: label, Width: c.Width, Height: c.Height}
}

// Matches says whether a restored session shows what was chosen before. It only compares
// what both sides know, and reports why it refused.
//
// A monitor must have the same output name, or with no names the same position and size;
// a size change of a named output is accepted (resolution changes are the person's own).
// A window must belong to the same application; its caption is not compared, because
// titles change (a browser tab, an editor's file).
func (c Choice) Matches(got Choice) (bool, string) {
	if c.Kind != got.Kind {
		return false, fmt.Sprintf("restored a %s, chose a %s", got.Kind, c.Kind)
	}
	switch c.Kind {
	case KindMonitor:
		if c.Output != "" && got.Output != "" {
			if c.Output != got.Output {
				return false, fmt.Sprintf("restored output %s, chose %s", got.Output, c.Output)
			}
			return true, ""
		}
		if c.Width > 0 && got.Width > 0 && (c.Width != got.Width || c.Height != got.Height) {
			return false, fmt.Sprintf("restored a %dx%d output, chose %dx%d", got.Width, got.Height, c.Width, c.Height)
		}
		if c.X != got.X || c.Y != got.Y {
			return false, fmt.Sprintf("restored the output at %d,%d, chose the one at %d,%d", got.X, got.Y, c.X, c.Y)
		}
		return true, ""
	case KindWindow:
		if c.WindowClass != "" && got.WindowClass != "" && !strings.EqualFold(c.WindowClass, got.WindowClass) {
			return false, fmt.Sprintf("restored a window of %s, chose one of %s", got.WindowClass, c.WindowClass)
		}
		return true, ""
	}
	return false, "unknown kind"
}

// Record is what is kept between sessions for one kind of source.
type Record struct {
	// Token is the latest restore token: the portal rotates it on every Start.
	Token   string    `json:"token"`
	Choice  Choice    `json:"choice"`
	SavedAt time.Time `json:"savedAt"`
}

// Store keeps one Record per source kind in a 0600 JSON file. A restore token lets this
// user's helper share that source again without asking, so it is treated like a credential.
type Store struct {
	Path string
}

// StorePath is the file in the helper's config directory.
func StorePath(configDir string) string { return filepath.Join(configDir, "screencast.json") }

func (s Store) load() (map[string]Record, error) {
	b, err := os.ReadFile(s.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]Record{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]Record{}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("%s: %w", s.Path, err)
	}
	return out, nil
}

// Load returns the record for kind; a missing file or kind gives an empty record.
func (s Store) Load(kind Kind) (Record, error) {
	all, err := s.load()
	if err != nil {
		return Record{}, err
	}
	return all[kind.String()], nil
}

// Save replaces the record for kind.
func (s Store) Save(kind Kind, r Record) error {
	all, err := s.load()
	if err != nil {
		// A corrupt file must not block saving the new token.
		all = map[string]Record{}
	}
	all[kind.String()] = r
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	tmp := s.Path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.Path)
}

// SaveToken stores a rotated token and keeps the choice, so a token is never lost even
// when the source later fails to start.
func (s Store) SaveToken(kind Kind, token string, now time.Time) error {
	if token == "" {
		return nil
	}
	r, err := s.Load(kind)
	if err != nil {
		r = Record{}
	}
	r.Token, r.SavedAt = token, now
	return s.Save(kind, r)
}

// Forget drops the token for kind (after the portal refused it, or on --pick).
func (s Store) Forget(kind Kind) error {
	r, err := s.Load(kind)
	if err != nil || r.Token == "" {
		return err
	}
	r.Token = ""
	return s.Save(kind, r)
}
