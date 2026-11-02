// SPDX-License-Identifier: AGPL-3.0-only

package sidecar

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

// The vectors are the same as macos-capture/Tests/CaptureProtocolTests/WireTests.swift's.
func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.ReplaceAll(s, " ", ""))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func encode(t *testing.T, typ Type, payload []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := Write(&b, typ, payload); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestControlVectors(t *testing.T) {
	cases := []struct {
		typ     Type
		payload []byte
		want    string
		layer   int
		value   int
	}{
		{TypeKeyframe, KeyframePayload(2), "00000002 21 02", 2, 0},
		{TypeBitrate, BitratePayload(1, 3500), "00000006 22 01 00000dac", 1, 3500},
		{TypeFPS, FPSPayload(0, 120), "00000004 23 00 0078", 0, 120},
		{TypeCurtain, CurtainPayload(true), "00000002 25 01", 0, 1},
		{TypeCurtain, CurtainPayload(false), "00000002 25 00", 0, 0},
	}
	for _, c := range cases {
		got := encode(t, c.typ, c.payload)
		if !bytes.Equal(got, unhex(t, c.want)) {
			t.Errorf("0x%02x: got % x, want %s", byte(c.typ), got, c.want)
		}
		m, err := Read(bytes.NewReader(got))
		if err != nil {
			t.Fatal(err)
		}
		layer, value, err := ParseControl(m)
		if err != nil || layer != c.layer || value != c.value {
			t.Errorf("0x%02x: parsed %d, %d, %v", byte(c.typ), layer, value, err)
		}
	}
	if got := encode(t, TypeStop, nil); !bytes.Equal(got, unhex(t, "00000001 24")) {
		t.Errorf("stop: % x", got)
	}
}

func TestVideoVector(t *testing.T) {
	v := Video{Layer: 1, Keyframe: true, PTSNanos: 0x0102030405060708, EncodeMicros: 1500, Data: []byte{0, 0, 0, 1, 0x65}}
	wire := encode(t, TypeVideo, v.Payload())
	if want := unhex(t, "00000014 03 01 01 0102030405060708 000005dc 0000000165"); !bytes.Equal(wire, want) {
		t.Fatalf("got % x", wire)
	}
	m, err := Read(bytes.NewReader(wire))
	if err != nil || m.Type != TypeVideo {
		t.Fatal(m.Type, err)
	}
	back, err := ParseVideo(m.Payload)
	if err != nil || back.Layer != 1 || !back.Keyframe || back.PTSNanos != v.PTSNanos || back.EncodeMicros != 1500 || !bytes.Equal(back.Data, v.Data) {
		t.Fatalf("%+v %v", back, err)
	}
}

func TestAudioVector(t *testing.T) {
	a := Audio{PTSNanos: 20_000_000, DurationMicros: 20000, Data: []byte{0xf8, 0xff, 0xfe}}
	wire := encode(t, TypeAudio, a.Payload())
	if want := unhex(t, "00000010 04 0000000001312d00 00004e20 f8fffe"); !bytes.Equal(wire, want) {
		t.Fatalf("got % x", wire)
	}
	m, _ := Read(bytes.NewReader(wire))
	back, err := ParseAudio(m.Payload)
	if err != nil || back.PTSNanos != a.PTSNanos || back.DurationMicros != a.DurationMicros || !bytes.Equal(back.Data, a.Data) {
		t.Fatalf("%+v %v", back, err)
	}
}

func TestReadErrors(t *testing.T) {
	if _, err := Read(bytes.NewReader(unhex(t, "00000000"))); !errors.Is(err, ErrMessageSize) {
		t.Errorf("zero length: %v", err)
	}
	if _, err := Read(bytes.NewReader(unhex(t, "7fffffff 03"))); !errors.Is(err, ErrMessageSize) {
		t.Errorf("huge length: %v", err)
	}
	if _, err := Read(bytes.NewReader(unhex(t, "00000005 03 01"))); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("truncated: %v", err)
	}
	if _, err := Read(bytes.NewReader(nil)); !errors.Is(err, io.EOF) {
		t.Errorf("empty: %v", err)
	}
	if _, err := ParseVideo(make([]byte, VideoHeaderSize-1)); err == nil {
		t.Error("short video accepted")
	}
	if _, err := ParseAudio(make([]byte, AudioHeaderSize-1)); err == nil {
		t.Error("short audio accepted")
	}
}

func TestReadStream(t *testing.T) {
	var b bytes.Buffer
	_ = WriteJSON(&b, TypeStats, Stats{Captured: 60})
	_ = Write(&b, TypeStop, nil)
	m1, err := Read(&b)
	if err != nil || m1.Type != TypeStats {
		t.Fatal(m1.Type, err)
	}
	var st Stats
	if err := m1.Decode(&st); err != nil || st.Captured != 60 {
		t.Fatal(st, err)
	}
	if m2, err := Read(&b); err != nil || m2.Type != TypeStop || len(m2.Payload) != 0 {
		t.Fatal(m2, err)
	}
}

// TestConfigJSON pins the keys the Swift side decodes (WireTests.testConfigJSON).
func TestConfigJSON(t *testing.T) {
	c := Config{
		Source:     SourceRef{Kind: "display", ID: 1},
		Layers:     []LayerConfig{{RID: "f", Width: 1920, Height: 1080, FPS: 60, Kbps: 8000, VBVMs: 250}},
		GOPSeconds: 10, Cursor: true,
		Audio:     &AudioConfig{PID: 42},
		Thumbnail: &ThumbnailConfig{Width: 320, EveryMs: 2000},
	}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"source":{"kind":"display","id":1},"layers":[{"rid":"f","width":1920,"height":1080,"fps":60,"kbps":8000,"vbvMs":250}],"gopSeconds":10,"cursor":true,"audio":{"pid":42},"thumbnail":{"width":320,"everyMs":2000}}`
	if string(b) != want {
		t.Errorf("got  %s\nwant %s", b, want)
	}
}

// The agent's JSON as the Swift side reads and writes it (WireTests.swift testAgentJSON).
func TestAgentJSON(t *testing.T) {
	on := true
	menu := Menu{Icon: "live", Tooltip: "Live", Items: []MenuItem{
		{ID: 1, Label: "Live"},
		{ID: 10, Separator: true},
		{ID: 12, Label: "Privacy curtain", Enabled: true, Checked: &on},
	}}
	b, err := json.Marshal(menu)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"icon":"live","tooltip":"Live","items":[{"id":1,"label":"Live"},{"id":10,"separator":true},{"id":12,"label":"Privacy curtain","enabled":true,"checked":true}]}`
	if string(b) != want {
		t.Errorf("menu %s\nwant %s", b, want)
	}
	b, _ = json.Marshal(Hotkeys{Bindings: []HotkeyBinding{{Action: "curtain", Trigger: "CTRL+ALT+SHIFT+h", KeyCode: 4, Modifiers: 0x1a00}}})
	if want := `{"bindings":[{"action":"curtain","trigger":"CTRL+ALT+SHIFT+h","keyCode":4,"modifiers":6656}]}`; string(b) != want {
		t.Errorf("hotkeys %s", b)
	}
	// What the Swift agent sends (sorted keys).
	var bound HotkeysBound
	if err := json.Unmarshal([]byte(`{"results":[{"action":"stop","conflict":true,"error":"taken","ok":false,"trigger":"CTRL+ALT+SHIFT+x"}]}`), &bound); err != nil {
		t.Fatal(err)
	}
	if r := bound.Results[0]; r.Action != "stop" || r.OK || !r.Conflict || r.Trigger != "CTRL+ALT+SHIFT+x" {
		t.Errorf("bound %+v", bound)
	}
}
