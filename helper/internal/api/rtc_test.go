// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/henriquefps/openlive/helper/internal/rtc"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// sfuProxy is the Worker's /api/rtc/rooms/r_1/* for a helper: it records each request
// and answers with the REST fixtures.
type sfuProxy struct {
	t *testing.T

	mu       sync.Mutex
	requests []string // "METHOD path body"
	refuse   *protocol.ErrorPayload
}

func (s *sfuProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.requests = append(s.requests, r.Method+" "+r.URL.Path+" "+string(raw))
	refuse := s.refuse
	s.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer dev-token" {
		s.t.Errorf("%s %s without the device token", r.Method, r.URL.Path)
	}
	w.Header().Set("Content-Type", "application/json")
	if refuse != nil {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(refuse)
		return
	}
	answer := func(status int, name string) {
		w.WriteHeader(status)
		_, _ = w.Write(fixtureBytes(s.t, name))
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/rooms/r_1":
		_, _ = w.Write([]byte(`{"room":{"id":"r_1","settings":{},"effectiveSettings":{"maxStreams":5,"maxViewersPerStream":6,"maxBitrateKbps":12000,"allowedPresets":["text","game","max"]}}}`))
	case "POST /api/rtc/rooms/r_1/ice":
		answer(200, "IceServersResponse")
	case "POST /api/rtc/rooms/r_1/publish":
		answer(201, "PublishResponse")
	case "PUT /api/rtc/rooms/r_1/publish/renegotiate":
		answer(200, "RenegotiateResponse.answer")
	case "POST /api/rtc/rooms/r_1/unpublish":
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}

func (s *sfuProxy) last() (method, path string, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	parts := strings.SplitN(s.requests[len(s.requests)-1], " ", 3)
	return parts[0], parts[1], []byte(parts[2])
}

func newSignaler(t *testing.T) (*sfuProxy, *Signaler) {
	t.Helper()
	proxy := &sfuProxy{t: t}
	ts := httptest.NewServer(proxy)
	t.Cleanup(ts.Close)
	c, err := NewClient(ts.URL, "dev-token", "openlive-helper/test")
	if err != nil {
		t.Fatal(err)
	}
	return proxy, &Signaler{Client: c, RoomID: "r_1", Preset: protocol.PresetGame, MaxBitrateKbps: 9000}
}

func TestSignalerPublishRenegotiateUnpublish(t *testing.T) {
	proxy, sig := newSignaler(t)
	ctx := context.Background()

	settings, err := sig.Client.RoomSettings(ctx, "r_1")
	if err != nil || settings.MaxBitrateKbps != 12000 || len(settings.AllowedPresets) != 3 {
		t.Fatalf("room settings %+v, %v", settings, err)
	}

	ice, err := sig.Client.ICEServers(ctx, "r_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(ice) != 2 || ice[1].Username == nil || *ice[1].Username != "u" || len(ice[1].Urls) != 2 {
		t.Fatalf("ice %+v", ice)
	}

	res, err := sig.Publish(ctx, rtc.SessionDescription{Type: "offer", SDP: "v=0"}, []rtc.PublishedTrack{
		{Mid: "0", Name: "video", Kind: "video", Rids: []string{"f", "h", "q"}},
		{Mid: "1", Name: "audio", Kind: "audio"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := fixture[protocol.PublishResponse](t, "PublishResponse")
	if res.SessionID != want.SFUSessionID || res.Answer.Type != "answer" || res.Answer.SDP != want.SessionDescription.SDP {
		t.Fatalf("publish result %+v", res)
	}
	if sig.AnnounceWithin != 60*time.Second {
		t.Fatalf("announce within %v", sig.AnnounceWithin)
	}
	// The request is the fixture's PublishRequest, field for field (no SFU-only fields
	// such as location).
	_, _, body := proxy.last()
	var got, wantReq map[string]any
	_ = json.Unmarshal(body, &got)
	_ = json.Unmarshal(fixtureBytes(t, "PublishRequest"), &wantReq)
	wantReq["sessionDescription"] = map[string]any{"type": "offer", "sdp": "v=0"}
	if g, w := mustJSON(t, got), mustJSON(t, wantReq); g != w {
		t.Fatalf("publish body\n got %s\nwant %s", g, w)
	}

	answer, err := sig.Renegotiate(ctx, res.SessionID, rtc.SessionDescription{Type: "offer", SDP: "v=1"})
	if err != nil || answer.Type != "answer" {
		t.Fatalf("renegotiate %+v %v", answer, err)
	}
	method, path, body := proxy.last()
	var reneg protocol.PublishRenegotiateRequest
	_ = json.Unmarshal(body, &reneg)
	if method != "PUT" || path != "/api/rtc/rooms/r_1/publish/renegotiate" || reneg.SFUSessionID != res.SessionID || reneg.SessionDescription.SDP != "v=1" {
		t.Fatalf("renegotiate request %s %s %+v", method, path, reneg)
	}

	if err := sig.Unpublish(ctx, res.SessionID); err != nil {
		t.Fatal(err)
	}
	_, path, body = proxy.last()
	var unpub protocol.UnpublishRequest
	_ = json.Unmarshal(body, &unpub)
	if path != "/api/rtc/rooms/r_1/unpublish" || unpub.SFUSessionID != res.SessionID {
		t.Fatalf("unpublish request %s %+v", path, unpub)
	}
}

func TestSignalerPublishRefused(t *testing.T) {
	proxy, sig := newSignaler(t)
	proxy.refuse = &protocol.ErrorPayload{Code: protocol.ErrorCodeBitrateNotAllowed, Limit: ptr(6000)}
	_, err := sig.Publish(context.Background(), rtc.SessionDescription{Type: "offer", SDP: "v=0"}, []rtc.PublishedTrack{{Mid: "0", Name: "video", Kind: "video"}})
	var apiErr *Error
	if ErrorCode(err) != protocol.ErrorCodeBitrateNotAllowed || !errors.As(err, &apiErr) || apiErr.Payload.Limit == nil || *apiErr.Payload.Limit != 6000 {
		t.Fatalf("err %v, want 403 bitrate_not_allowed {limit: 6000}", err)
	}
}

func fixtureBytes(t *testing.T, name string) []byte {
	t.Helper()
	return []byte(mustJSON(t, fixture[any](t, name)))
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
