// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/media"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// audioSession is a live session that captures a browser window's audio.
type audioSession struct {
	*fakeSession
	app *protocol.HelperAudioApp
}

func (s audioSession) AudioApp() *protocol.HelperAudioApp { return s.app }

func TestControllerReportsTheVoiceSink(t *testing.T) {
	c, hub := newTestController(nil)
	ctx := context.Background()
	c.attach(ctx, hub)
	if st := hub.status(t, protocol.HelperStateIdle); st.VoiceSink != nil {
		t.Fatalf("no sink yet: %+v", st.VoiceSink)
	}
	c.setVoiceSink(ctx, &protocol.VoiceSink{Name: "openlive-voice", Label: "Openlive – voice"})
	if st := hub.status(t, protocol.HelperStateIdle); st.VoiceSink == nil || st.VoiceSink.Label != "Openlive – voice" {
		t.Fatalf("sink = %+v", st.VoiceSink)
	}
	// It goes on being reported with every status, and goes away when the sink does.
	c.attach(ctx, hub)
	if st := hub.status(t, protocol.HelperStateIdle); st.VoiceSink == nil {
		t.Fatal("re-attach lost the sink")
	}
	c.setVoiceSink(ctx, nil)
	if st := hub.status(t, protocol.HelperStateIdle); st.VoiceSink != nil {
		t.Fatalf("sink after it went: %+v", st.VoiceSink)
	}
}

func TestControllerSetsTheVoiceOutput(t *testing.T) {
	c, hub := newTestController(nil)
	ctx := context.Background()
	// Without a voice sink the command is still acknowledged.
	c.handle(ctx, hub, cmd("h_0", &protocol.HelperSetVoiceOutputPayload{DeviceID: "d_pc"}))
	if _, ok := hub.reply(t, "h_0").(protocol.AckPayload); !ok {
		t.Fatal("not acked without a sink")
	}
	var got []string
	c.voiceOutput = func(label string) { got = append(got, label) }
	label := "USB Speakers"
	c.handle(ctx, hub, cmd("h_1", &protocol.HelperSetVoiceOutputPayload{DeviceID: "d_pc", Label: &label}))
	hub.reply(t, "h_1")
	c.handle(ctx, hub, cmd("h_2", &protocol.HelperSetVoiceOutputPayload{DeviceID: "d_pc"}))
	hub.reply(t, "h_2")
	if len(got) != 2 || got[0] != "USB Speakers" || got[1] != "" {
		t.Fatalf("outputs = %q", got)
	}
}

func TestControllerReportsWhoseAudioItCaptures(t *testing.T) {
	browser := protocol.BrowserFamilyChromium
	app := &protocol.HelperAudioApp{Name: "brave-browser", Binary: ptr("brave"), Browser: &browser}
	s := audioSession{fakeSession: &fakeSession{done: make(chan struct{})}, app: app}
	c, hub := newTestController(func(context.Context, protocol.HelperStartStreamPayload, media.Source) (session, error) {
		return s, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.handle(ctx, hub, cmd("h_1", &protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "w_1", Preset: protocol.PresetGame, Audio: true}))
	c.attach(ctx, hub)
	st := hub.status(t, protocol.HelperStateLive)
	if st.Stream.AudioApp == nil || st.Stream.AudioApp.Name != "brave-browser" || *st.Stream.AudioApp.Browser != protocol.BrowserFamilyChromium {
		t.Fatalf("audio app = %+v", st.Stream.AudioApp)
	}
}

type audioStream struct {
	media.Stream
	app media.AudioApp
	ok  bool
}

func (s audioStream) AudioApp() (media.AudioApp, bool) { return s.app, s.ok }

func TestAudioAppOf(t *testing.T) {
	if a := audioAppOf(audioStream{}); a != nil {
		t.Fatalf("no app audio: %+v", a)
	}
	a := audioAppOf(audioStream{app: media.AudioApp{Name: "org.mozilla.firefox", Binary: "firefox", PID: 42}, ok: true})
	if a == nil || a.Name != "org.mozilla.firefox" || *a.Binary != "firefox" || *a.Pid != 42 || *a.Browser != protocol.BrowserFamilyFirefox {
		t.Fatalf("firefox = %+v", a)
	}
	a = audioAppOf(audioStream{app: media.AudioApp{Name: "steam_app_570"}, ok: true})
	if a == nil || a.Browser != nil || a.Binary != nil || a.Pid != nil {
		t.Fatalf("a game = %+v", a)
	}
}
