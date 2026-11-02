// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func testTokenStore(t *testing.T, s TokenStore) {
	t.Helper()
	const a, b = "https://a.example", "https://b.example"
	if _, err := s.Get(a); !errors.Is(err, ErrNoToken) {
		t.Fatalf("empty store: %v, want ErrNoToken", err)
	}
	if err := s.Set(a, "tok-a"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(b, "tok-b"); err != nil {
		t.Fatal(err)
	}
	if tok, err := s.Get(a); err != nil || tok != "tok-a" {
		t.Fatalf("Get(a) = %q, %v", tok, err)
	}
	if err := s.Delete(a); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(a); !errors.Is(err, ErrNoToken) {
		t.Fatalf("after delete: %v", err)
	}
	if tok, _ := s.Get(b); tok != "tok-b" {
		t.Fatalf("other instance lost its token: %q", tok)
	}
	if err := s.Delete(a); err != nil {
		t.Fatalf("deleting a missing token: %v", err)
	}
}

func TestKeyring(t *testing.T) {
	keyring.MockInit()
	testTokenStore(t, Keyring{})
}

func TestFileStore(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cfg")
	f := &File{Path: TokenFilePath(dir)}
	testTokenStore(t, f)
	st, err := os.Stat(f.Path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode %v, want 0600", st.Mode().Perm())
	}
	if dst, _ := os.Stat(dir); dst.Mode().Perm() != 0o700 {
		t.Fatalf("directory mode %v, want 0700", dst.Mode().Perm())
	}
	if err := os.Chmod(f.Path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Get("https://b.example"); err == nil {
		t.Fatal("read a token file other users can read")
	}
}

func TestConfig(t *testing.T) {
	path := ConfigPath(t.TempDir())
	c, err := LoadConfig(path)
	if err != nil || c.DefaultInstance != "" {
		t.Fatalf("missing config: %+v, %v", c, err)
	}
	c.Remember(Instance{URL: "https://openlive.example.com", DeviceID: "d_pc", PairedAt: time.Unix(1, 0).UTC()})
	if err := SaveConfig(path, c); err != nil {
		t.Fatal(err)
	}
	got, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.DefaultInstance != "https://openlive.example.com" || got.Instances["https://openlive.example.com"].DeviceID != "d_pc" {
		t.Fatalf("config %+v", got)
	}
}
