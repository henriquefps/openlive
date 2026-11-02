// SPDX-License-Identifier: AGPL-3.0-only

// Package store keeps the helper's device tokens and configuration.
//
// Device tokens go to the OS keyring (Secret Service on Linux, Keychain on macOS,
// Credential Manager on Windows), one entry per instance. A plain file
// with mode 0600 is the fallback for CI and headless machines without a keyring, and is
// only used when the person asks for it explicitly.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/henriquefps/openlive/helper/internal/notify"
)

// ErrNoToken means the instance has no stored token (the helper is not paired).
var ErrNoToken = errors.New("no device token stored for this instance")

// TokenStore stores one device token per instance URL.
type TokenStore interface {
	Get(instance string) (string, error)
	Set(instance, token string) error
	Delete(instance string) error
	// Name describes where tokens live, for `status`.
	Name() string
}

// KeyringService is the keyring service name of every entry.
const KeyringService = "openlive-helper"

// Keyring stores tokens in the OS keyring.
type Keyring struct{}

func (Keyring) Name() string { return "system keyring" }

func (Keyring) Get(instance string) (string, error) {
	tok, err := keyring.Get(KeyringService, instance)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNoToken
	}
	return tok, err
}

func (Keyring) Set(instance, token string) error { return keyring.Set(KeyringService, instance, token) }

func (Keyring) Delete(instance string) error {
	err := keyring.Delete(KeyringService, instance)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// File stores tokens in a JSON file readable only by its owner (0600, directory 0700).
// It refuses to read a file that group or others can access.
type File struct {
	Path string
	mu   sync.Mutex
}

func (f *File) Name() string { return "file " + f.Path + " (insecure fallback)" }

func (f *File) load() (map[string]string, error) {
	st, err := os.Stat(f.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	if st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is accessible by other users (mode %v); run chmod 600 on it", f.Path, st.Mode().Perm())
	}
	raw, err := os.ReadFile(f.Path)
	if err != nil {
		return nil, err
	}
	tokens := map[string]string{}
	if err := json.Unmarshal(raw, &tokens); err != nil {
		return nil, fmt.Errorf("%s: %w", f.Path, err)
	}
	return tokens, nil
}

func (f *File) save(tokens map[string]string) error {
	raw, err := json.MarshalIndent(tokens, "", "  ")
	if err != nil {
		return err
	}
	return writePrivate(f.Path, raw)
}

func (f *File) Get(instance string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	tokens, err := f.load()
	if err != nil {
		return "", err
	}
	tok, ok := tokens[instance]
	if !ok {
		return "", ErrNoToken
	}
	return tok, nil
}

func (f *File) Set(instance, token string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	tokens, err := f.load()
	if err != nil {
		return err
	}
	tokens[instance] = token
	return f.save(tokens)
}

func (f *File) Delete(instance string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	tokens, err := f.load()
	if err != nil {
		return err
	}
	delete(tokens, instance)
	return f.save(tokens)
}

// writePrivate writes atomically with mode 0600 in a 0700 directory.
func writePrivate(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Instance is what the helper remembers about one paired instance (never the token).
type Instance struct {
	URL        string    `json:"url"`
	DeviceID   string    `json:"deviceId"`
	DeviceName string    `json:"deviceName,omitempty"`
	PairedAt   time.Time `json:"pairedAt"`
}

// Config is the helper's configuration file.
type Config struct {
	// DefaultInstance is used when a command gets no --instance.
	DefaultInstance string              `json:"defaultInstance,omitempty"`
	Instances       map[string]Instance `json:"instances,omitempty"`
	// Desktop holds the tray, shortcut and notification settings of "run".
	Desktop *Desktop `json:"desktop,omitempty"`
}

// Desktop is the "desktop" block of the config file; every field is
// optional and documented in helper/README.md.
type Desktop struct {
	// Tray false runs without the tray icon.
	Tray *bool `json:"tray,omitempty"`
	// Shortcuts maps an action (curtain, pause, stop) to a trigger ("Ctrl+Alt+Shift+H");
	// "" or "off" turns one off, a missing one takes its default.
	Shortcuts map[string]string `json:"shortcuts,omitempty"`
	// Notifications switches the desktop notifications and their sounds.
	Notifications notify.Settings `json:"notifications"`
	// Language of the tray and notifications: "en" or "pt-BR" (default: the system locale).
	Language string `json:"language,omitempty"`
}

// DefaultDir is <user config dir>/openlive-helper, or $OPENLIVE_HELPER_CONFIG_DIR.
func DefaultDir() (string, error) {
	if d := os.Getenv("OPENLIVE_HELPER_CONFIG_DIR"); d != "" {
		return d, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "openlive-helper"), nil
}

// ConfigPath is the config file inside dir.
func ConfigPath(dir string) string { return filepath.Join(dir, "config.json") }

// TokenFilePath is the insecure token file inside dir.
func TokenFilePath(dir string) string { return filepath.Join(dir, "tokens.json") }

// LoadConfig reads the config file; a missing file is an empty config.
func LoadConfig(path string) (Config, error) {
	var c Config
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

// SaveConfig writes the config file (0600: it names the instances you use).
func SaveConfig(path string, c Config) error {
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writePrivate(path, append(raw, '\n'))
}

// Remember records a paired instance and makes it the default.
func (c *Config) Remember(in Instance) {
	if c.Instances == nil {
		c.Instances = map[string]Instance{}
	}
	c.Instances[in.URL] = in
	c.DefaultInstance = in.URL
}
