// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// ErrPairingExpired: nobody confirmed the code in time (there is no refusal: an unconfirmed
// code simply expires, PROTOCOL.md §11.1).
var ErrPairingExpired = errors.New("the pairing code expired before it was confirmed")

// PairingPrompt is what the helper shows the person: the code and where to type it.
type PairingPrompt struct {
	UserCode string
	// URL opens the link page with the code filled in.
	URL       string
	ExpiresAt time.Time
}

// Pairer runs the device pairing flow:
//
//	request a code → show it and open the browser → poll until confirmed, refused or expired.
type Pairer struct {
	Client *Client
	// Prompt is called once with the code. OpenBrowser failures are not fatal (the
	// person can type the URL).
	Prompt      func(PairingPrompt)
	OpenBrowser func(url string) error
	// Sleep waits between polls; tests replace it.
	Sleep func(ctx context.Context, d time.Duration) error
	Now   func() time.Time
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// slowDownStep is how much a slow_down without intervalMs adds (RFC 8628 §3.5).
const slowDownStep = 5 * time.Second

func millis(ms int) time.Duration { return time.Duration(ms) * time.Millisecond }

// Pair returns the device token once a signed-in person confirmed the code
// (PROTOCOL.md §11.1).
func (p *Pairer) Pair(ctx context.Context, req protocol.DeviceCodeRequest) (protocol.DeviceTokenResponse, error) {
	sleep, now := p.Sleep, p.Now
	if sleep == nil {
		sleep = sleepCtx
	}
	if now == nil {
		now = time.Now
	}
	var none protocol.DeviceTokenResponse
	var code protocol.DeviceCodeResponse
	if err := p.Client.Do(ctx, "POST", pathDeviceCode, req, &code); err != nil {
		return none, fmt.Errorf("request a pairing code: %w", err)
	}
	if code.DeviceCode == "" || code.UserCode == "" {
		return none, errors.New("request a pairing code: the answer has no code")
	}
	prompt := PairingPrompt{UserCode: code.UserCode, URL: code.VerificationURIComplete, ExpiresAt: now().Add(millis(code.ExpiresInMs))}
	if prompt.URL == "" {
		prompt.URL = code.VerificationURI
	}
	if prompt.URL == "" {
		prompt.URL = p.Client.Base.JoinPath(pathLink).String() + "?code=" + code.UserCode
	}
	if code.ExpiresInMs <= 0 {
		prompt.ExpiresAt = now().Add(10 * time.Minute)
	}
	if p.Prompt != nil {
		p.Prompt(prompt)
	}
	if p.OpenBrowser != nil {
		_ = p.OpenBrowser(prompt.URL)
	}

	interval := max(millis(code.IntervalMs), time.Second)
	for {
		if err := sleep(ctx, interval); err != nil {
			return none, err
		}
		if !now().Before(prompt.ExpiresAt) {
			return none, ErrPairingExpired
		}
		var tok protocol.DeviceTokenResponse
		err := p.Client.Do(ctx, "POST", pathDeviceToken, protocol.DeviceTokenRequest{DeviceCode: code.DeviceCode}, &tok)
		var apiErr *Error
		switch {
		case err == nil:
			if tok.DeviceToken == "" || tok.DeviceID == "" {
				return none, errors.New("pairing: the answer has no token")
			}
			return tok, nil
		case !errors.As(err, &apiErr) || apiErr.Status >= 500:
			// Network trouble or a 5xx: keep polling until the code expires.
			continue
		}
		switch e := apiErr.Payload; e.Code {
		case protocol.ErrorCodeAuthorizationPending:
		case protocol.ErrorCodeSlowDown:
			// The server says the new interval; RFC 8628 adds 5 s when it does not.
			if e.IntervalMs != nil && millis(*e.IntervalMs) > interval {
				interval = millis(*e.IntervalMs)
			} else {
				interval += slowDownStep
			}
		case protocol.ErrorCodeRateLimited:
			if e.RetryAfterMs != nil && millis(*e.RetryAfterMs) > interval {
				interval = millis(*e.RetryAfterMs)
			} else {
				interval += slowDownStep
			}
		case protocol.ErrorCodeExpiredToken:
			return none, ErrPairingExpired
		default:
			return none, fmt.Errorf("pairing: %w", err)
		}
	}
}
