// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// ProtocolVersion is the protocol this helper speaks (PROTOCOL.md §1): 1.1 added device
// pairing, the SFU proxy and the stream lifecycle; 1.2 the per-layer helper.stats. 1.9 (room
// capabilities) needs nothing here: capability_disabled is an error like the others, and
// room.updated goes to web tabs only. 1.10 (the voice channel) neither: voice messages go to web
// tabs only, and the room refuses them from a helper. 1.11 (the text chat) and 1.12 (cameras in
// the voice channel) neither, for the same reason. 1.13 to 1.20 are all spoken: AV1 (1.14,
// 1.17), the do_quota_exceeded code (1.15), the voice sink (1.16), the encoded layers (1.19)
// and pointer pings (1.20). It stayed at 1.12 by mistake until 1.20, so the web hid the voice
// sink and the go-live pings switch and called the helper outdated; it must follow the
// protocol package now (TestProtocolVersionIsCurrent). Kept as a literal: helper:publish reads it.
var ProtocolVersion = protocol.ProtocolVersion{Major: 1, Minor: 21}

// PingInterval is how often the client pings (PROTOCOL.md §4).
const PingInterval = 30 * time.Second

// ReconnectGrace is how long the room keeps a helper's stream after its socket drops; a
// hello from the same device within it keeps the stream (PROTOCOL.md §7.2 point 5).
const ReconnectGrace = 15 * time.Second

// ErrStreamLost: the socket came back but the room no longer has the stream.
var ErrStreamLost = errors.New("the room ended the stream while the helper was disconnected")

// maxFrame is the largest frame the protocol allows (PROTOCOL.md §2).
const maxFrame = 512 << 10

// ReplyError is an `error` reply on the socket.
type ReplyError struct {
	Payload protocol.ErrorPayload
}

func (e *ReplyError) Error() string { return "server error: " + string(e.Payload.Code) }

// CloseError says how the server closed the socket (PROTOCOL.md §5).
type CloseError struct {
	Code   protocol.CloseCode
	Reason string
}

func (e *CloseError) Error() string { return fmt.Sprintf("socket closed with %d %s", e.Code, e.Reason) }

// Reconnect reports whether a client should reconnect after this close: not after
// 4001–4006 (PROTOCOL.md §5).
func (e *CloseError) Reconnect() bool { return e.Code < 4001 || e.Code > 4006 }

// RoomOptions are the hello fields.
type RoomOptions struct {
	DeviceID      string
	ClientVersion string
	// PingInterval defaults to 30 s; tests shorten it.
	PingInterval time.Duration
}

// RoomConn is the helper's connection to one room's RoomDO.
type RoomConn struct {
	conn    *websocket.Conn
	welcome protocol.WelcomePayload

	nextID  atomic.Int64
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan reply

	events chan protocol.Payload
	done   chan struct{}
	err    error
	cancel context.CancelFunc
}

type reply struct {
	payload protocol.Payload
	err     error
}

func socketURL(base *url.URL, path string) string {
	u := *base.JoinPath(path)
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	return u.String()
}

// DialRoom connects to GET /ws/rooms/:roomId with the device token, sends hello and
// waits for welcome.
func DialRoom(ctx context.Context, c *Client, roomID string, opts RoomOptions) (*RoomConn, error) {
	conn, err := dialSocket(ctx, c, fmt.Sprintf(pathRoomSocketFmt, url.PathEscape(roomID)))
	if err != nil {
		return nil, err
	}
	r := &RoomConn{conn: conn, pending: map[string]chan reply{}, events: make(chan protocol.Payload, 64), done: make(chan struct{})}

	hello := protocol.HelloPayload{Protocol: ProtocolVersion, Client: protocol.ClientKindHelper, ClientVersion: opts.ClientVersion, DeviceID: &opts.DeviceID}
	id := r.newID()
	if err := r.write(ctx, id, hello); err != nil {
		_ = conn.CloseNow()
		return nil, err
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			_ = conn.CloseNow()
			return nil, closeErr(err)
		}
		env, p, err := protocol.Decode(data)
		if err != nil {
			continue // unknown or malformed: ignored (PROTOCOL.md §1)
		}
		if env.ID != id {
			// Events can precede the welcome; keep them for Events.
			if _, isPong := p.(*protocol.PongPayload); !isPong {
				select {
				case r.events <- p:
				default:
				}
			}
			continue
		}
		switch p := p.(type) {
		case *protocol.WelcomePayload:
			r.welcome = *p
		case *protocol.ErrorPayload:
			_ = conn.CloseNow()
			return nil, &ReplyError{Payload: *p}
		default:
			_ = conn.CloseNow()
			return nil, fmt.Errorf("hello: unexpected reply %s", env.Type)
		}
		break
	}

	loopCtx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	go r.readLoop(loopCtx)
	interval := opts.PingInterval
	if interval == 0 {
		interval = PingInterval
	}
	go pingLoop(loopCtx, interval, r.writeRaw)
	return r, nil
}

// dialSocket opens a WebSocket with the device token. A refused upgrade carries a JSON
// ErrorPayload (PROTOCOL.md §2), returned as *Error.
func dialSocket(ctx context.Context, c *Client, path string) (*websocket.Conn, error) {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+c.Token)
	if c.UserAgent != "" {
		header.Set("User-Agent", c.UserAgent)
	}
	conn, res, err := websocket.Dial(ctx, socketURL(c.Base, path), &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if res != nil && res.StatusCode != http.StatusSwitchingProtocols {
			e := &Error{Status: res.StatusCode}
			if res.Body != nil {
				raw, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
				_ = json.Unmarshal(raw, &e.Payload)
			}
			return nil, e
		}
		return nil, err
	}
	conn.SetReadLimit(maxFrame)
	return conn, nil
}

// Welcome is the room's welcome (room, settings, members, live streams).
func (r *RoomConn) Welcome() protocol.WelcomePayload { return r.welcome }

// Events delivers server messages that are not replies: stream.stop, kicked,
// room.closed, permissions.changed, presence. It is closed when the socket closes.
func (r *RoomConn) Events() <-chan protocol.Payload { return r.events }

// Done is closed when the socket closes; Err then says how.
func (r *RoomConn) Done() <-chan struct{} { return r.done }

// Err is a *CloseError for a close frame, another error for a broken connection.
func (r *RoomConn) Err() error {
	select {
	case <-r.done:
		return r.err
	default:
		return nil
	}
}

func (r *RoomConn) newID() string { return strconv.FormatInt(r.nextID.Add(1), 10) }

func (r *RoomConn) write(ctx context.Context, id string, p protocol.Payload) error {
	frame, err := protocol.Encode(id, p)
	if err != nil {
		return err
	}
	return r.writeRaw(ctx, frame)
}

func (r *RoomConn) writeRaw(ctx context.Context, frame []byte) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	return r.conn.Write(ctx, websocket.MessageText, frame)
}

func closeErr(err error) error {
	if code := websocket.CloseStatus(err); code != -1 {
		var ce websocket.CloseError
		reason := ""
		if errors.As(err, &ce) {
			reason = ce.Reason
		}
		return &CloseError{Code: protocol.CloseCode(code), Reason: reason}
	}
	return err
}

func (r *RoomConn) readLoop(ctx context.Context) {
	defer r.cancel()
	for {
		_, data, err := r.conn.Read(ctx)
		if err != nil {
			r.shutdown(closeErr(err))
			return
		}
		env, p, err := protocol.Decode(data)
		if err != nil {
			continue
		}
		if _, isPong := p.(*protocol.PongPayload); isPong {
			continue
		}
		if env.ID != "" {
			r.mu.Lock()
			ch, ok := r.pending[env.ID]
			delete(r.pending, env.ID)
			r.mu.Unlock()
			if ok {
				ch <- reply{payload: p}
				// A reply can double as an event (stream.started); only the event copy
				// without our id reaches the others, so nothing else to do here.
				continue
			}
		}
		select {
		case r.events <- p:
		case <-ctx.Done():
			r.shutdown(ctx.Err())
			return
		}
	}
}

// pingLoop sends PROTOCOL.md §4's exact ping frame, which the DOs answer without waking.
func pingLoop(ctx context.Context, every time.Duration, write func(context.Context, []byte) error) {
	ping, _ := protocol.Encode("", protocol.PingPayload{})
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			_ = write(wctx, ping)
			cancel()
		case <-ctx.Done():
			return
		}
	}
}

func (r *RoomConn) shutdown(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	select {
	case <-r.done:
		return
	default:
	}
	r.err = err
	for id, ch := range r.pending {
		ch <- reply{err: err}
		delete(r.pending, id)
	}
	close(r.done)
	close(r.events)
}

// Request sends p with a fresh id and waits for its reply. An `error` reply is
// returned as *ReplyError.
func (r *RoomConn) Request(ctx context.Context, p protocol.Payload) (protocol.Payload, error) {
	id := r.newID()
	ch := make(chan reply, 1)
	r.mu.Lock()
	select {
	case <-r.done:
		r.mu.Unlock()
		return nil, r.err
	default:
	}
	r.pending[id] = ch
	r.mu.Unlock()
	if err := r.write(ctx, id, p); err != nil {
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
		return nil, err
	}
	select {
	case rep := <-ch:
		if rep.err != nil {
			return nil, rep.err
		}
		if e, ok := rep.payload.(*protocol.ErrorPayload); ok {
			return nil, &ReplyError{Payload: *e}
		}
		return rep.payload, nil
	case <-ctx.Done():
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
		return nil, ctx.Err()
	}
}

func expect[T protocol.Payload](p protocol.Payload, err error) (T, error) {
	var zero T
	if err != nil {
		return zero, err
	}
	v, ok := p.(T)
	if !ok {
		return zero, fmt.Errorf("unexpected reply %s", p.Type())
	}
	return v, nil
}

// Announce sends stream.announce and returns the stream the room created.
func (r *RoomConn) Announce(ctx context.Context, a protocol.StreamAnnouncePayload) (protocol.StreamInfo, error) {
	started, err := expect[*protocol.StreamStartedPayload](r.Request(ctx, a))
	if err != nil {
		return protocol.StreamInfo{}, err
	}
	return started.Stream, nil
}

// Update sends stream.update (pause or preset change).
func (r *RoomConn) Update(ctx context.Context, u protocol.StreamUpdatePayload) error {
	_, err := expect[*protocol.AckPayload](r.Request(ctx, u))
	return err
}

// End sends stream.end.
func (r *RoomConn) End(ctx context.Context, streamID string) error {
	_, err := expect[*protocol.AckPayload](r.Request(ctx, protocol.StreamEndPayload{StreamID: streamID}))
	return err
}

// Close closes the socket normally.
func (r *RoomConn) Close() error {
	err := r.conn.Close(websocket.StatusNormalClosure, "")
	r.cancel() // unblocks the read loop if nobody drains Events
	<-r.done
	return err
}

// retryable reports whether a failed dial is worth repeating: network trouble, a 5xx or
// an abnormal close, but not a refusal (4xx, an error reply, close codes 4001–4006).
func retryable(err error) bool {
	var apiErr *Error
	var replyErr *ReplyError
	var closeErr *CloseError
	switch {
	case errors.As(err, &apiErr):
		return apiErr.Status >= 500
	case errors.As(err, &replyErr):
		return false
	case errors.As(err, &closeErr):
		return closeErr.Reconnect()
	}
	return true
}

// Resume reconnects after the socket dropped at droppedAt: it says hello again with the
// same deviceId until ReconnectGrace runs out, then checks that the welcome still lists
// streamID. Delays between attempts are 250 ms doubling up to 2 s.
func Resume(ctx context.Context, c *Client, roomID string, opts RoomOptions, streamID string, droppedAt time.Time) (*RoomConn, error) {
	ctx, cancel := context.WithDeadline(ctx, droppedAt.Add(ReconnectGrace))
	defer cancel()
	delay := 250 * time.Millisecond
	for {
		r, err := DialRoom(ctx, c, roomID, opts)
		if err == nil {
			for _, s := range r.Welcome().Streams {
				if s.StreamID == streamID {
					return r, nil
				}
			}
			_ = r.Close()
			return nil, ErrStreamLost
		}
		if !retryable(err) {
			return nil, err
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("no connection within the %v grace: %w", ReconnectGrace, err)
		}
		if err := sleepCtx(ctx, delay); err != nil {
			return nil, fmt.Errorf("no connection within the %v grace: %w", ReconnectGrace, ErrStreamLost)
		}
		delay = min(2*delay, 2*time.Second)
	}
}
