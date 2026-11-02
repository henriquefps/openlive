// SPDX-License-Identifier: AGPL-3.0-only

// Package api talks to an Openlive instance: REST over HTTPS (device pairing, SFU
// signaling through the Worker) and the room WebSocket (docs/PROTOCOL.md), with the
// types generated in packages/protocol/go.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// Client is an HTTP client for one instance. Token is the device token; it is empty
// while pairing.
type Client struct {
	Base      *url.URL
	Token     string
	HTTP      *http.Client
	UserAgent string
}

// NewClient parses the instance URL (https://openlive.example). Plain http is accepted
// only for localhost, for wrangler dev.
func NewClient(instance, token, userAgent string) (*Client, error) {
	u, err := ParseInstance(instance)
	if err != nil {
		return nil, err
	}
	return &Client{Base: u, Token: token, HTTP: &http.Client{Timeout: 30 * time.Second}, UserAgent: userAgent}, nil
}

// ParseInstance normalizes an instance URL to scheme://host[:port] with no path.
func ParseInstance(instance string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(instance), "/"))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid instance URL %q (want https://host)", instance)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if h := u.Hostname(); h != "localhost" && h != "127.0.0.1" && h != "::1" {
			return nil, fmt.Errorf("instance %s: plain http is only allowed for localhost", instance)
		}
	default:
		return nil, fmt.Errorf("instance %s: scheme must be https", instance)
	}
	if u.Path != "" || u.RawQuery != "" || u.User != nil {
		return nil, fmt.Errorf("instance %s: give only scheme and host", instance)
	}
	return &url.URL{Scheme: u.Scheme, Host: u.Host}, nil
}

// Error is a non-2xx REST answer. Payload is the flat ErrorPayload every REST error
// carries (PROTOCOL.md §6); Code is empty when the body was not one.
type Error struct {
	Status  int
	Payload protocol.ErrorPayload
}

func (e *Error) Error() string {
	if e.Payload.Code == "" {
		return fmt.Sprintf("HTTP %d", e.Status)
	}
	return fmt.Sprintf("HTTP %d %s", e.Status, e.Payload.Code)
}

// ErrorCode returns the protocol error code of err, or "".
func ErrorCode(err error) protocol.ErrorCode {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr.Payload.Code
	}
	var wsErr *ReplyError
	if errors.As(err, &wsErr) {
		return wsErr.Payload.Code
	}
	return ""
}

// URL resolves a path against the instance.
func (c *Client) URL(path string) string { return c.Base.JoinPath(path).String() }

// Do sends a JSON request and decodes a JSON answer into out (when not nil).
func (c *Client) Do(ctx context.Context, method, path string, in, out any) error {
	var body []byte
	header := http.Header{}
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = raw
		header.Set("Content-Type", "application/json")
	}
	return c.DoRaw(ctx, method, path, body, header, out)
}

// DoRaw sends body as is with the given headers (Content-Type among them) and decodes a
// JSON answer into out (when not nil).
func (c *Client) DoRaw(ctx context.Context, method, path string, body []byte, header http.Header, out any) error {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL(path), r)
	if err != nil {
		return err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	req.Header.Set("Accept", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		e := &Error{Status: res.StatusCode}
		_ = json.Unmarshal(raw, &e.Payload)
		return e
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s %s: invalid JSON answer: %w", method, path, err)
	}
	return nil
}
