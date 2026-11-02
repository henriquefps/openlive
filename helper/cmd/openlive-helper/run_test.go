// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"testing"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/media"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

func TestSourceBackendsListAndRoute(t *testing.T) {
	linux := &fakeBackend{sources: []media.Source{
		{ID: media.PortalScreenID, Kind: media.SourceScreen, Label: "A monitor"},
		{ID: media.PortalWindowID, Kind: media.SourceWindow, Label: "A window", HasAudio: true},
	}}
	test := &fakeBackend{sources: []media.Source{testSource}}
	var apps []string
	b := &sourceBackends{
		screen: func(app string) (media.MediaBackend, error) { apps = append(apps, app); return linux, nil },
		test:   test,
	}
	sources, err := b.ListSources(context.Background())
	if err != nil || len(sources) != 3 || sources[0].ID != media.PortalScreenID || sources[2].ID != "test" {
		t.Fatalf("sources = %+v, %v", sources, err)
	}

	req := protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", Audio: true}
	if got, _ := b.backendFor(req, testSource); got != test || !b.audio(req, testSource) {
		t.Fatal("the test source goes to the test backend, with its tone")
	}
	window := sources[1]
	apps = nil
	if got, _ := b.backendFor(req, window); got != linux || apps[0] != "window" || !b.audio(req, window) {
		t.Fatalf("a window goes to the Linux backend with its own app's audio (apps %v)", apps)
	}
	screen := sources[0]
	apps = nil
	if _, _ = b.backendFor(req, screen); apps[0] != "" || b.audio(req, screen) {
		t.Fatalf("a whole screen has no app audio yet (apps %v)", apps)
	}

	// Without the test backend, the test source is not found.
	b.test = nil
	_, err = b.backendFor(req, testSource)
	var re *api.ReplyError
	if !errors.As(err, &re) || re.Payload.Code != protocol.ErrorCodeSourceNotFound {
		t.Fatalf("err = %v", err)
	}
}
