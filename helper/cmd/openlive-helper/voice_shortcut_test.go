// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/hotkeys"
	"github.com/henriquefps/openlive/helper/internal/media"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

func voiceShortcutFrame(h *recordingHub) (protocol.HelperVoiceShortcutPayload, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i, f := range h.frames {
		if p, ok := f.payload.(protocol.HelperVoiceShortcutPayload); ok {
			h.frames = append(h.frames[:i], h.frames[i+1:]...)
			return p, true
		}
	}
	return protocol.HelperVoiceShortcutPayload{}, false
}

// The voice shortcuts reach the web as helper.voiceShortcut whether or not a stream runs:
// push-to-talk reports both edges, the toggles only the press.
func TestVoiceShortcutsReachTheWeb(t *testing.T) {
	c, hub := newTestController(func(context.Context, protocol.HelperStartStreamPayload, media.Source) (session, error) {
		return nil, nil
	})
	ctx := context.Background()
	d := &desktop{ctl: c, log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	// No hub socket: dropped without a panic.
	d.shortcut(hotkeys.Event{Action: hotkeys.Talk})

	c.attach(ctx, hub)
	hub.status(t, protocol.HelperStateIdle)

	for _, tc := range []struct {
		ev   hotkeys.Event
		want *protocol.HelperVoiceShortcutPayload
	}{
		{hotkeys.Event{Action: hotkeys.Talk}, &protocol.HelperVoiceShortcutPayload{DeviceID: "d_pc", Action: protocol.VoiceShortcutActionPushToTalk, Pressed: true}},
		{hotkeys.Event{Action: hotkeys.Talk, Released: true}, &protocol.HelperVoiceShortcutPayload{DeviceID: "d_pc", Action: protocol.VoiceShortcutActionPushToTalk, Pressed: false}},
		{hotkeys.Event{Action: hotkeys.Mute}, &protocol.HelperVoiceShortcutPayload{DeviceID: "d_pc", Action: protocol.VoiceShortcutActionToggleMute, Pressed: true}},
		{hotkeys.Event{Action: hotkeys.Mute, Released: true}, nil},
		{hotkeys.Event{Action: hotkeys.Deafen}, &protocol.HelperVoiceShortcutPayload{DeviceID: "d_pc", Action: protocol.VoiceShortcutActionToggleDeafen, Pressed: true}},
		{hotkeys.Event{Action: hotkeys.Deafen, Released: true}, nil},
		// The stream shortcuts are not voice shortcuts.
		{hotkeys.Event{Action: hotkeys.Curtain}, nil},
		{hotkeys.Event{Action: hotkeys.Stop, Released: true}, nil},
	} {
		d.shortcut(tc.ev)
		got, ok := voiceShortcutFrame(hub)
		switch {
		case tc.want == nil && ok:
			t.Errorf("%+v sent %+v", tc.ev, got)
		case tc.want != nil && (!ok || got != *tc.want):
			t.Errorf("%+v sent %+v (%v), want %+v", tc.ev, got, ok, *tc.want)
		}
	}
}
