// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// fixture decodes packages/protocol/fixtures/rest/<name>.json, the bodies both protocol
// test suites check against the schema.
func fixture[T any](t *testing.T, name string) T {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "protocol", "fixtures", "rest", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return v
}

// pairingServer answers the token poll from a script of (status, body) steps.
type pairingServer struct {
	t     *testing.T
	steps []step

	mu       sync.Mutex
	polls    int
	codeReqs []protocol.DeviceCodeRequest
	code     protocol.DeviceCodeResponse
}

type step struct {
	status int
	body   any
}

func (s *pairingServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case pathDeviceCode:
		var req protocol.DeviceCodeRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.codeReqs = append(s.codeReqs, req)
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(s.code)
	case pathDeviceToken:
		var req protocol.DeviceTokenRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.DeviceCode != s.code.DeviceCode {
			s.t.Errorf("poll with device code %q", req.DeviceCode)
		}
		s.mu.Lock()
		i := min(s.polls, len(s.steps)-1)
		s.polls++
		st := s.steps[i]
		s.mu.Unlock()
		w.WriteHeader(st.status)
		_ = json.NewEncoder(w).Encode(st.body)
	default:
		http.NotFound(w, r)
	}
}

func pending() step {
	return step{400, protocol.ErrorPayload{Code: protocol.ErrorCodeAuthorizationPending}}
}

// fakeClock advances only when the pairer sleeps.
type fakeClock struct {
	now    time.Time
	sleeps []time.Duration
}

func (c *fakeClock) sleep(_ context.Context, d time.Duration) error {
	c.sleeps = append(c.sleeps, d)
	c.now = c.now.Add(d)
	return nil
}

func token(t *testing.T) step {
	return step{200, fixture[protocol.DeviceTokenResponse](t, "DeviceTokenResponse")}
}

func runPairing(t *testing.T, steps ...step) (protocol.DeviceTokenResponse, *fakeClock, PairingPrompt, *pairingServer, error) {
	t.Helper()
	return runPairingWith(t, fixture[protocol.DeviceCodeResponse](t, "DeviceCodeResponse"), steps...)
}

func runPairingWith(t *testing.T, code protocol.DeviceCodeResponse, steps ...step) (protocol.DeviceTokenResponse, *fakeClock, PairingPrompt, *pairingServer, error) {
	t.Helper()
	srv := &pairingServer{t: t, steps: steps, code: code}
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	c, err := NewClient(ts.URL, "", "openlive-helper/test")
	if err != nil {
		t.Fatal(err)
	}
	clock := &fakeClock{now: time.Unix(0, 0)}
	var prompt PairingPrompt
	var opened string
	p := &Pairer{
		Client:      c,
		Prompt:      func(pp PairingPrompt) { prompt = pp },
		OpenBrowser: func(u string) error { opened = u; return errors.New("no browser") },
		Sleep:       clock.sleep,
		Now:         func() time.Time { return clock.now },
	}
	name := "PC"
	tok, err := p.Pair(context.Background(), protocol.DeviceCodeRequest{Name: &name, OS: protocol.DeviceOSLinux, Arch: protocol.DeviceArchAmd64, HelperVersion: "0.1.0"})
	if prompt.URL != opened {
		t.Errorf("opened %q, prompt says %q", opened, prompt.URL)
	}
	return tok, clock, prompt, srv, err
}

func TestPairingSucceedsAfterPendingAndSlowDown(t *testing.T) {
	tok, clock, prompt, srv, err := runPairing(t,
		pending(),
		step{400, protocol.ErrorPayload{Code: protocol.ErrorCodeSlowDown, IntervalMs: ptr(10000)}},
		pending(),
		token(t),
	)
	if err != nil {
		t.Fatal(err)
	}
	if tok.DeviceID != "d_6f1c" || tok.DeviceToken == "" {
		t.Fatalf("token %+v", tok)
	}
	if prompt.UserCode != "K7F-2QM" || prompt.URL != "https://openlive.example/link?code=K7F-2QM" {
		t.Fatalf("prompt %+v", prompt)
	}
	// intervalMs 5000, then the 10 s slow_down asks for.
	want := []time.Duration{5 * time.Second, 5 * time.Second, 10 * time.Second, 10 * time.Second}
	if !slices.Equal(clock.sleeps, want) {
		t.Fatalf("sleeps %v, want %v", clock.sleeps, want)
	}
	if req := srv.codeReqs[0]; req.OS != protocol.DeviceOSLinux || req.Arch != protocol.DeviceArchAmd64 || req.HelperVersion != "0.1.0" || req.Name == nil || *req.Name != "PC" {
		t.Fatalf("code request %+v", req)
	}
}

func TestPairingSlowDownWithoutInterval(t *testing.T) {
	_, clock, _, _, err := runPairing(t, step{400, protocol.ErrorPayload{Code: protocol.ErrorCodeSlowDown}}, token(t))
	if err != nil {
		t.Fatal(err)
	}
	if want := []time.Duration{5 * time.Second, 10 * time.Second}; !slices.Equal(clock.sleeps, want) {
		t.Fatalf("sleeps %v, want %v (RFC 8628 adds 5 s)", clock.sleeps, want)
	}
}

func TestPairingDefaultLinkURL(t *testing.T) {
	code := fixture[protocol.DeviceCodeResponse](t, "DeviceCodeResponse")
	code.VerificationURI, code.VerificationURIComplete = "", ""
	_, _, prompt, _, _ := runPairingWith(t, code, token(t))
	if !strings.HasSuffix(prompt.URL, "/link?code=K7F-2QM") {
		t.Fatalf("link URL %q, want …/link?code=K7F-2QM", prompt.URL)
	}
}

func TestPairingUnknownRefusalStops(t *testing.T) {
	_, _, _, srv, err := runPairing(t, pending(), step{400, protocol.ErrorPayload{Code: protocol.ErrorCodeInvalidMessage}})
	if ErrorCode(err) != protocol.ErrorCodeInvalidMessage || srv.polls != 2 {
		t.Fatalf("err %v after %d polls, want invalid_message after 2", err, srv.polls)
	}
}

func TestPairingExpiredByServer(t *testing.T) {
	_, _, _, _, err := runPairing(t, step{400, protocol.ErrorPayload{Code: protocol.ErrorCodeExpiredToken}})
	if !errors.Is(err, ErrPairingExpired) {
		t.Fatalf("err %v, want ErrPairingExpired", err)
	}
}

func TestPairingExpiresLocally(t *testing.T) {
	// Always pending: after expiresInMs (600 s) the helper stops polling by itself.
	_, clock, _, srv, err := runPairing(t, pending())
	if !errors.Is(err, ErrPairingExpired) {
		t.Fatalf("err %v, want ErrPairingExpired", err)
	}
	if got := clock.now.Sub(time.Unix(0, 0)); got != 600*time.Second {
		t.Fatalf("gave up after %v, want 600 s", got)
	}
	if srv.polls != 119 {
		t.Fatalf("%d polls, want 119 (every 5 s, stopping at expiry)", srv.polls)
	}
}

func TestPairingServerErrorIsRetriedClientErrorIsNot(t *testing.T) {
	tok, _, _, _, err := runPairing(t, step{503, map[string]any{}}, token(t))
	if err != nil || tok.DeviceToken == "" {
		t.Fatalf("after a 503: %+v, %v", tok, err)
	}
	_, _, _, _, err = runPairing(t, step{404, "not found"})
	if err == nil {
		t.Fatal("a 404 was retried")
	}
}

func TestPairingRateLimitedWaitsRetryAfter(t *testing.T) {
	_, clock, _, _, err := runPairing(t, step{429, protocol.ErrorPayload{Code: protocol.ErrorCodeRateLimited, RetryAfterMs: ptr(30000)}}, token(t))
	if err != nil {
		t.Fatal(err)
	}
	if want := []time.Duration{5 * time.Second, 30 * time.Second}; !slices.Equal(clock.sleeps, want) {
		t.Fatalf("sleeps %v, want %v", clock.sleeps, want)
	}
}

func ptr[T any](v T) *T { return &v }

func TestParseInstance(t *testing.T) {
	for in, want := range map[string]string{
		"https://openlive.example.com":  "https://openlive.example.com",
		"https://openlive.example.com/": "https://openlive.example.com",
		"http://localhost:8787":         "http://localhost:8787",
	} {
		u, err := ParseInstance(in)
		if err != nil || u.String() != want {
			t.Errorf("ParseInstance(%q) = %v, %v; want %s", in, u, err, want)
		}
	}
	for _, bad := range []string{"openlive.example.com", "http://openlive.example.com", "https://x/path", "ftp://x"} {
		if _, err := ParseInstance(bad); err == nil {
			t.Errorf("ParseInstance(%q) accepted", bad)
		}
	}
}
