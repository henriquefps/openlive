// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package overlay

import "testing"

func TestWireArgs(t *testing.T) {
	m := new(msg).u32(7).str("wl_output").i32(-1).str("").fixed(1.5)
	if len(m.buf)%4 != 0 {
		t.Fatalf("unpadded message of %d bytes", len(m.buf))
	}
	r := argReader{b: m.buf}
	if v := r.u32(); v != 7 {
		t.Errorf("u32 %d", v)
	}
	if s := r.str(); s != "wl_output" {
		t.Errorf("str %q", s)
	}
	if v := r.i32(); v != -1 {
		t.Errorf("i32 %d", v)
	}
	if s := r.str(); s != "" {
		t.Errorf("empty str %q", s)
	}
	if v := r.i32(); v != 384 {
		t.Errorf("fixed 1.5 = %d, want 384", v)
	}
	if r.err != nil || len(r.b) != 0 {
		t.Errorf("err %v, %d bytes left", r.err, len(r.b))
	}
	_ = r.u32()
	if r.err == nil {
		t.Error("reading past the end is no error")
	}
}

func TestSocketPath(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	if p, err := socketPath(); err != nil || p != "/run/user/1000/wayland-0" {
		t.Errorf("%q %v", p, err)
	}
	t.Setenv("WAYLAND_DISPLAY", "/tmp/w")
	if p, _ := socketPath(); p != "/tmp/w" {
		t.Errorf("absolute: %q", p)
	}
	t.Setenv("WAYLAND_DISPLAY", "")
	if _, err := socketPath(); err == nil {
		t.Error("no error outside Wayland")
	}
	if s := Probe(); s.OK() || s.Wayland {
		t.Errorf("probe outside Wayland: %+v", s)
	}
}
