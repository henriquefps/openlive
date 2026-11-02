// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

const pathHubSocket = "/ws/hub"

// HubOptions are the hello fields of the hub socket.
type HubOptions struct {
	DeviceID      string
	ClientVersion string
	// PingInterval defaults to 30 s; tests shorten it.
	PingInterval time.Duration
}

// Command is a message the hub relays from one of the user's web tabs (PROTOCOL.md §8.2).
// ID is the hub's id for it: the reply must carry it (Reply), and an empty ID wants no
// reply on success.
type Command struct {
	ID      string
	Payload protocol.Payload
}

// HubConn is the helper's connection to its user's UserHubDO: the web controls the helper
// through it, with no port open on this machine.
type HubConn struct {
	conn    *websocket.Conn
	welcome protocol.HubWelcomePayload

	writeMu  sync.Mutex
	commands chan Command

	mu     sync.Mutex
	done   chan struct{}
	err    error
	cancel context.CancelFunc
}

// DialHub connects to GET /ws/hub with the device token, sends hello and waits for
// hub.welcome.
func DialHub(ctx context.Context, c *Client, opts HubOptions) (*HubConn, error) {
	conn, err := dialSocket(ctx, c, pathHubSocket)
	if err != nil {
		return nil, err
	}
	h := &HubConn{conn: conn, commands: make(chan Command, 64), done: make(chan struct{})}
	const helloID = "hello"
	hello := protocol.HelloPayload{Protocol: ProtocolVersion, Client: protocol.ClientKindHelper, ClientVersion: opts.ClientVersion, DeviceID: &opts.DeviceID}
	if err := h.write(ctx, helloID, hello); err != nil {
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
		if err != nil || env.ID != helloID {
			continue // unknown, malformed or unrelated before the welcome: ignored
		}
		switch p := p.(type) {
		case *protocol.HubWelcomePayload:
			h.welcome = *p
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
	h.cancel = cancel
	go h.readLoop(loopCtx)
	interval := opts.PingInterval
	if interval == 0 {
		interval = PingInterval
	}
	go pingLoop(loopCtx, interval, h.writeRaw)
	return h, nil
}

// Welcome is the hub's welcome (protocol version and the helpers online).
func (h *HubConn) Welcome() protocol.HubWelcomePayload { return h.welcome }

// Commands delivers what the hub sends: commands from the web, and the odd event or error
// (session_expired before 4001). It is closed when the socket closes.
func (h *HubConn) Commands() <-chan Command { return h.commands }

// Done is closed when the socket closes; Err then says how.
func (h *HubConn) Done() <-chan struct{} { return h.done }

// Err is a *CloseError for a close frame, another error for a broken connection.
func (h *HubConn) Err() error {
	select {
	case <-h.done:
		return h.err
	default:
		return nil
	}
}

// Reply answers a command: helper.sources, ack or error, under the command's id.
func (h *HubConn) Reply(ctx context.Context, id string, p protocol.Payload) error {
	return h.write(ctx, id, p)
}

// Send sends a report for the user's web tabs: helper.status, helper.stats or
// helper.sourceThumbnail.
func (h *HubConn) Send(ctx context.Context, p protocol.Payload) error {
	return h.write(ctx, "", p)
}

// Close closes the socket normally.
func (h *HubConn) Close() error {
	err := h.conn.Close(websocket.StatusNormalClosure, "")
	h.cancel()
	<-h.done
	return err
}

func (h *HubConn) write(ctx context.Context, id string, p protocol.Payload) error {
	frame, err := protocol.Encode(id, p)
	if err != nil {
		return err
	}
	return h.writeRaw(ctx, frame)
}

func (h *HubConn) writeRaw(ctx context.Context, frame []byte) error {
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	return h.conn.Write(ctx, websocket.MessageText, frame)
}

func (h *HubConn) readLoop(ctx context.Context) {
	defer h.cancel()
	for {
		_, data, err := h.conn.Read(ctx)
		if err != nil {
			h.shutdown(closeErr(err))
			return
		}
		env, p, err := protocol.Decode(data)
		if err != nil {
			continue
		}
		if _, isPong := p.(*protocol.PongPayload); isPong {
			continue
		}
		select {
		case h.commands <- Command{ID: env.ID, Payload: p}:
		case <-ctx.Done():
			h.shutdown(ctx.Err())
			return
		}
	}
}

func (h *HubConn) shutdown(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	select {
	case <-h.done:
		return
	default:
	}
	h.err = err
	close(h.done)
	close(h.commands)
}

// HubBackoff is the wait before reconnecting after attempt failures in a row: 1 s
// doubling up to 30 s.
func HubBackoff(attempt int) time.Duration {
	d := time.Second << min(attempt, 5)
	return min(d, 30*time.Second)
}

// Retryable reports whether a failed or dropped connection is worth trying again: not
// after a refusal (4xx, an error reply, close codes 4001–4006).
func Retryable(err error) bool { return retryable(err) }
