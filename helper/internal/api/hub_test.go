// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// fakeHub is a minimal UserHubDO: it checks the upgrade, answers hello with hub.welcome and
// hands every later frame to the test, which drives the socket through conn.
type fakeHub struct {
	t      *testing.T
	hello  chan protocol.HelloPayload
	frames chan []byte
	conn   chan *websocket.Conn
	// refuse answers the hello with this error, then closes with closeCode.
	refuse    *protocol.ErrorPayload
	closeCode websocket.StatusCode
}

func newFakeHub(t *testing.T) (*fakeHub, *Client) {
	t.Helper()
	f := &fakeHub{t: t, hello: make(chan protocol.HelloPayload, 4), frames: make(chan []byte, 64), conn: make(chan *websocket.Conn, 4)}
	ts := httptest.NewServer(f)
	t.Cleanup(ts.Close)
	c, err := NewClient(ts.URL, "dev-token", "openlive-helper/test")
	if err != nil {
		t.Fatal(err)
	}
	return f, c
}

func (f *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ws/hub" {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("Authorization") != "Bearer dev-token" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(protocol.ErrorPayload{Code: protocol.ErrorCodeUnauthenticated})
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		f.t.Errorf("accept: %v", err)
		return
	}
	ctx := context.Background()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		env, p, err := protocol.Decode(data)
		if err != nil {
			f.t.Errorf("decode %s: %v", data, err)
			continue
		}
		switch p := p.(type) {
		case *protocol.HelloPayload:
			f.hello <- *p
			if f.refuse != nil {
				writeFrame(f.t, conn, env.ID, *f.refuse)
				_ = conn.Close(f.closeCode, "")
				return
			}
			// An unrelated message first: the client must wait for the reply with its id.
			writeFrame(f.t, conn, "", protocol.HelperOfflinePayload{DeviceID: "d_other"})
			writeFrame(f.t, conn, env.ID, protocol.HubWelcomePayload{
				Protocol: protocol.ProtocolVersion{Major: 1, Minor: 3}, MinProtocol: protocol.ProtocolVersion{Major: 1},
				ServerTime: 1, UserID: "u_1", ConnectionID: "c_1",
			})
			f.conn <- conn
		case *protocol.PingPayload:
			_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"pong","payload":{}}`))
		default:
			f.frames <- data
		}
	}
}

func writeFrame(t *testing.T, conn *websocket.Conn, id string, p protocol.Payload) {
	t.Helper()
	frame, err := protocol.Encode(id, p)
	if err != nil {
		t.Errorf("encode: %v", err)
	}
	_ = conn.Write(context.Background(), websocket.MessageText, frame)
}

func (f *fakeHub) next(t *testing.T) (protocol.Envelope, protocol.Payload) {
	t.Helper()
	select {
	case data := <-f.frames:
		env, p, err := protocol.Decode(data)
		if err != nil {
			t.Fatal(err)
		}
		return env, p
	case <-time.After(2 * time.Second):
		t.Fatal("no frame from the helper")
		return protocol.Envelope{}, nil
	}
}

func dialHub(t *testing.T, c *Client) *HubConn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h, err := DialHub(ctx, c, HubOptions{DeviceID: "d_pc", ClientVersion: "0.1.0", PingInterval: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func nextCommand(t *testing.T, h *HubConn) Command {
	t.Helper()
	select {
	case cmd, ok := <-h.Commands():
		if !ok {
			t.Fatal("commands closed")
		}
		return cmd
	case <-time.After(2 * time.Second):
		t.Fatal("no command")
		return Command{}
	}
}

func TestHubHelloAndWelcome(t *testing.T) {
	f, c := newFakeHub(t)
	h := dialHub(t, c)
	hello := <-f.hello
	if hello.Client != protocol.ClientKindHelper || hello.DeviceID == nil || *hello.DeviceID != "d_pc" || hello.Protocol != ProtocolVersion {
		t.Fatalf("hello = %+v", hello)
	}
	if w := h.Welcome(); w.UserID != "u_1" || w.Protocol.Minor != 3 {
		t.Fatalf("welcome = %+v", w)
	}
	// The event that came before the welcome is not delivered as a command.
	select {
	case cmd := <-h.Commands():
		t.Fatalf("unexpected command %+v", cmd)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestHubCommandsRepliesAndReports(t *testing.T) {
	f, c := newFakeHub(t)
	h := dialHub(t, c)
	conn := <-f.conn

	writeFrame(t, conn, "h_1", protocol.HelperListSourcesPayload{DeviceID: "d_pc", Thumbnails: true})
	cmd := nextCommand(t, h)
	if p, ok := cmd.Payload.(*protocol.HelperListSourcesPayload); !ok || cmd.ID != "h_1" || !p.Thumbnails {
		t.Fatalf("command = %+v", cmd)
	}
	ctx := context.Background()
	sources := []protocol.SourceDescriptor{{SourceID: "test", Kind: protocol.SourceKindScreen, Label: "Test pattern", HasAudio: true}}
	if err := h.Reply(ctx, cmd.ID, protocol.HelperSourcesPayload{DeviceID: "d_pc", Sources: sources}); err != nil {
		t.Fatal(err)
	}
	env, p := f.next(t)
	if env.ID != "h_1" || p.(*protocol.HelperSourcesPayload).Sources[0].SourceID != "test" {
		t.Fatalf("reply = %+v %+v", env, p)
	}

	if err := h.Send(ctx, protocol.HelperStatusPayload{DeviceID: "d_pc", State: protocol.HelperStateIdle}); err != nil {
		t.Fatal(err)
	}
	env, p = f.next(t)
	if env.ID != "" || p.(*protocol.HelperStatusPayload).State != protocol.HelperStateIdle {
		t.Fatalf("status = %+v %+v", env, p)
	}

	writeFrame(t, conn, "h_2", protocol.HelperStartStreamPayload{DeviceID: "d_pc", RoomID: "r_1", SourceID: "test", Preset: protocol.PresetGame, Audio: true})
	cmd = nextCommand(t, h)
	if p, ok := cmd.Payload.(*protocol.HelperStartStreamPayload); !ok || p.RoomID != "r_1" || p.Preset != protocol.PresetGame {
		t.Fatalf("command = %+v", cmd)
	}
	if err := h.Reply(ctx, cmd.ID, protocol.ErrorPayload{Code: protocol.ErrorCodeHelperBusy, DeviceID: ptrTo("d_pc")}); err != nil {
		t.Fatal(err)
	}
	if env, p := f.next(t); env.ID != "h_2" || p.(*protocol.ErrorPayload).Code != protocol.ErrorCodeHelperBusy {
		t.Fatalf("reply = %+v %+v", env, p)
	}
}

func TestHubCloseCodes(t *testing.T) {
	f, c := newFakeHub(t)
	h := dialHub(t, c)
	conn := <-f.conn
	writeFrame(t, conn, "", protocol.ErrorPayload{Code: protocol.ErrorCodeSessionExpired})
	_ = conn.Close(websocket.StatusCode(protocol.CloseCodeUnauthenticated), "unauthenticated")
	if cmd := nextCommand(t, h); cmd.Payload.(*protocol.ErrorPayload).Code != protocol.ErrorCodeSessionExpired {
		t.Fatalf("command = %+v", cmd)
	}
	select {
	case <-h.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("not done")
	}
	var ce *CloseError
	if !errors.As(h.Err(), &ce) || ce.Code != protocol.CloseCodeUnauthenticated || ce.Reconnect() || Retryable(h.Err()) {
		t.Fatalf("err = %v", h.Err())
	}
}

func TestHubRefusals(t *testing.T) {
	f, c := newFakeHub(t)
	f.refuse = &protocol.ErrorPayload{Code: protocol.ErrorCodeProtocolUnsupported}
	f.closeCode = websocket.StatusCode(protocol.CloseCodeProtocolUnsupported)
	_, err := DialHub(context.Background(), c, HubOptions{DeviceID: "d_pc", ClientVersion: "0.1.0"})
	var re *ReplyError
	if !errors.As(err, &re) || re.Payload.Code != protocol.ErrorCodeProtocolUnsupported || Retryable(err) {
		t.Fatalf("err = %v", err)
	}

	c.Token = "wrong"
	_, err = DialHub(context.Background(), c, HubOptions{DeviceID: "d_pc", ClientVersion: "0.1.0"})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized || apiErr.Payload.Code != protocol.ErrorCodeUnauthenticated {
		t.Fatalf("err = %v", err)
	}
}

func TestHubBackoff(t *testing.T) {
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	for attempt, w := range want {
		if got := HubBackoff(attempt); got != w {
			t.Errorf("HubBackoff(%d) = %v, want %v", attempt, got, w)
		}
	}
}

func ptrTo[T any](v T) *T { return &v }
