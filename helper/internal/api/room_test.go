// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// fakeRoom is a minimal RoomDO: it checks the upgrade, answers hello, stream.announce,
// stream.update and stream.end with the generated types, and records pings.
type fakeRoom struct {
	t *testing.T

	mu     sync.Mutex
	hello  protocol.HelloPayload
	pings  []string
	frames []string
	conn   *websocket.Conn
	hellos int
	// streams go into every welcome (the streams the room still has).
	streams []protocol.StreamInfo
}

func (f *fakeRoom) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ws/rooms/r_1" {
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
	f.mu.Lock()
	f.conn = conn
	f.mu.Unlock()
	ctx := context.Background()
	send := func(id string, p protocol.Payload) {
		frame, err := protocol.Encode(id, p)
		if err != nil {
			f.t.Errorf("encode: %v", err)
		}
		_ = conn.Write(ctx, websocket.MessageText, frame)
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		f.mu.Lock()
		f.frames = append(f.frames, string(data))
		f.mu.Unlock()
		env, p, err := protocol.Decode(data)
		if err != nil {
			f.t.Errorf("decode %s: %v", data, err)
			continue
		}
		switch p := p.(type) {
		case *protocol.HelloPayload:
			f.mu.Lock()
			f.hello = *p
			f.hellos++
			streams := f.streams
			f.mu.Unlock()
			// An unrelated event first: the client must wait for the reply with its id.
			send("", protocol.MemberLeftPayload{UserID: "u_other"})
			send(env.ID, protocol.WelcomePayload{
				Protocol: protocol.ProtocolVersion{Major: 1, Minor: 0}, MinProtocol: protocol.ProtocolVersion{Major: 1},
				ServerTime: 1, Room: protocol.RoomInfo{RoomID: "r_1"}, Streams: streams,
			})
		case *protocol.PingPayload:
			f.mu.Lock()
			f.pings = append(f.pings, string(data))
			f.mu.Unlock()
			_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"pong","payload":{}}`))
		case *protocol.StreamAnnouncePayload:
			if p.Preset == protocol.PresetMax {
				send(env.ID, protocol.ErrorPayload{Code: protocol.ErrorCodePresetNotAllowed, Preset: &p.Preset})
				continue
			}
			stream := protocol.StreamInfo{StreamID: "st_1", DeviceID: "d_pc", Source: p.Source, Preset: p.Preset, HasAudio: p.HasAudio}
			send(env.ID, protocol.StreamStartedPayload{Stream: stream})
		case *protocol.StreamUpdatePayload, *protocol.StreamEndPayload:
			send(env.ID, protocol.AckPayload{})
		}
	}
}

func (f *fakeRoom) serverConn() *websocket.Conn {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conn
}

func dialFake(t *testing.T, token string) (*fakeRoom, *RoomConn, error) {
	t.Helper()
	f, c := newFakeRoom(t, token)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := DialRoom(ctx, c, "r_1", fakeOptions)
	return f, conn, err
}

var fakeOptions = RoomOptions{DeviceID: "d_pc", ClientVersion: "0.1.0", PingInterval: 50 * time.Millisecond}

func newFakeRoom(t *testing.T, token string) (*fakeRoom, *Client) {
	t.Helper()
	f := &fakeRoom{t: t}
	ts := httptest.NewServer(f)
	t.Cleanup(ts.Close)
	c, err := NewClient("http://"+ts.Listener.Addr().String(), token, "openlive-helper/test")
	if err != nil {
		t.Fatal(err)
	}
	c.Base.Host = ts.Listener.Addr().String()
	return f, c
}

func TestRoomSocketStreamLifecycle(t *testing.T) {
	f, conn, err := dialFake(t, "dev-token")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if conn.Welcome().Room.RoomID != "r_1" {
		t.Fatalf("welcome %+v", conn.Welcome())
	}
	f.mu.Lock()
	hello := f.hello
	f.mu.Unlock()
	if hello.Client != protocol.ClientKindHelper || hello.DeviceID == nil || *hello.DeviceID != "d_pc" || hello.Protocol.Major != 1 {
		t.Fatalf("hello %+v", hello)
	}

	ctx := context.Background()
	stream, err := conn.Announce(ctx, protocol.StreamAnnouncePayload{
		SFUSessionID: "sess_1",
		Source:       protocol.SourceInfo{Kind: protocol.SourceKindScreen, Label: "Test pattern"},
		Preset:       protocol.PresetGame,
		Tracks:       []protocol.Track{{Name: "t-video", Kind: protocol.TrackKindVideo, Rids: []string{"f", "h", "q"}}},
		HasAudio:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if stream.StreamID != "st_1" || !stream.HasAudio {
		t.Fatalf("stream %+v", stream)
	}
	paused := true
	if err := conn.Update(ctx, protocol.StreamUpdatePayload{StreamID: "st_1", Paused: &paused}); err != nil {
		t.Fatal(err)
	}
	_, err = conn.Announce(ctx, protocol.StreamAnnouncePayload{Preset: protocol.PresetMax, Tracks: []protocol.Track{}})
	if ErrorCode(err) != protocol.ErrorCodePresetNotAllowed {
		t.Fatalf("announce max: %v, want preset_not_allowed", err)
	}
	if err := conn.End(ctx, "st_1"); err != nil {
		t.Fatal(err)
	}

	// The event sent before welcome is delivered.
	select {
	case ev := <-conn.Events():
		if left, ok := ev.(*protocol.MemberLeftPayload); !ok || left.UserID != "u_other" {
			t.Fatalf("event %#v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no event")
	}

	// Pings go out with the exact bytes the DO auto-responds to.
	deadline := time.Now().Add(2 * time.Second)
	for {
		f.mu.Lock()
		pings := append([]string(nil), f.pings...)
		f.mu.Unlock()
		if len(pings) > 0 {
			if pings[0] != `{"type":"ping","payload":{}}` {
				t.Fatalf("ping frame %s", pings[0])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no ping")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The server closes with 4005 room closed: no reconnect.
	_ = f.serverConn().Close(websocket.StatusCode(protocol.CloseCodeRoomClosed), "")
	select {
	case <-conn.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("socket not closed")
	}
	var ce *CloseError
	if !errors.As(conn.Err(), &ce) || ce.Code != protocol.CloseCodeRoomClosed || ce.Reconnect() {
		t.Fatalf("close error %v", conn.Err())
	}
	if _, err := conn.Request(ctx, protocol.StreamEndPayload{StreamID: "st_1"}); err == nil {
		t.Fatal("request after close succeeded")
	}
}

func TestRoomSocketRefusedUpgrade(t *testing.T) {
	_, _, err := dialFake(t, "wrong")
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized || apiErr.Payload.Code != protocol.ErrorCodeUnauthenticated {
		t.Fatalf("err %v, want 401 unauthenticated", err)
	}
}

func TestResumeKeepsTheStreamWithinGrace(t *testing.T) {
	f, c := newFakeRoom(t, "dev-token")
	f.streams = []protocol.StreamInfo{{StreamID: "st_1", DeviceID: "d_pc"}}
	ctx := context.Background()
	conn, err := DialRoom(ctx, c, "r_1", fakeOptions)
	if err != nil {
		t.Fatal(err)
	}
	// The connection breaks without a close frame (1006).
	_ = f.serverConn().CloseNow()
	<-conn.Done()
	var ce *CloseError
	if errors.As(conn.Err(), &ce) && !ce.Reconnect() {
		t.Fatalf("a dropped connection is final: %v", conn.Err())
	}

	again, err := Resume(ctx, c, "r_1", fakeOptions, "st_1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = again.Close() }()
	f.mu.Lock()
	hellos, hello := f.hellos, f.hello
	f.mu.Unlock()
	if hellos != 2 || hello.DeviceID == nil || *hello.DeviceID != "d_pc" {
		t.Fatalf("%d hellos, last %+v: want a second hello with the same deviceId", hellos, hello)
	}

	// The room no longer lists the stream: it is lost.
	f.mu.Lock()
	f.streams = nil
	f.mu.Unlock()
	if _, err := Resume(ctx, c, "r_1", fakeOptions, "st_1", time.Now()); !errors.Is(err, ErrStreamLost) {
		t.Fatalf("err %v, want ErrStreamLost", err)
	}
}

func TestResumeStopsOnRefusalAndAfterGrace(t *testing.T) {
	_, c := newFakeRoom(t, "revoked")
	start := time.Now()
	_, err := Resume(context.Background(), c, "r_1", fakeOptions, "st_1", start)
	if ErrorCode(err) != protocol.ErrorCodeUnauthenticated || time.Since(start) > time.Second {
		t.Fatalf("err %v after %v, want 401 unauthenticated at once", err, time.Since(start))
	}

	// Nothing listens: retried until the grace that started 14.5 s ago runs out.
	c.Base.Host = "127.0.0.1:1"
	start = time.Now()
	_, err = Resume(context.Background(), c, "r_1", fakeOptions, "st_1", start.Add(-ReconnectGrace+500*time.Millisecond))
	if err == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("err %v after %v, want a failure within the grace", err, time.Since(start))
	}
}
