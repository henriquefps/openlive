// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"

	"github.com/henriquefps/openlive/helper/internal/api"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

// explained is an error with a sentence for the person in front of the terminal. The
// server sends codes only (PROTOCOL.md §6); the code stays in the message for reports.
type explained struct {
	msg string
	err error
}

func (e *explained) Error() string { return fmt.Sprintf("%s (%v)", e.msg, e.err) }
func (e *explained) Unwrap() error { return e.err }

func intOr(p *int, fallback string) string {
	if p == nil {
		return fallback
	}
	return fmt.Sprint(*p)
}

// explain turns protocol error codes, from REST or the room socket, into what to do.
// Other errors pass through unchanged.
func explain(err error) error {
	var e protocol.ErrorPayload
	var apiErr *api.Error
	var replyErr *api.ReplyError
	var closeErr *api.CloseError
	switch {
	case errors.As(err, &apiErr):
		e = apiErr.Payload
	case errors.As(err, &replyErr):
		e = replyErr.Payload
	case errors.As(err, &closeErr):
		return explainClose(err, closeErr.Code)
	default:
		return err
	}
	var msg string
	switch e.Code {
	case protocol.ErrorCodeUnauthenticated, protocol.ErrorCodeSessionExpired:
		msg = "the instance refused this device's token (revoked, or the account was deleted): run openlive-helper pair again"
	case protocol.ErrorCodeForbidden:
		msg = "this account cannot use that room, or the request did not come from a paired helper"
	case protocol.ErrorCodeRoomNotFound:
		msg = "there is no room with that id, or this account cannot see it"
	case protocol.ErrorCodeRoomClosed:
		msg = "the room is closed"
	case protocol.ErrorCodeSpaceSuspended:
		msg = "the room's space is suspended by the platform admin"
	case protocol.ErrorCodeStreamPermissionRequired:
		msg = "this account may not stream in this room: ask a moderator for the stream permission"
	case protocol.ErrorCodeQuotaExhausted:
		msg = "the instance's streaming quota is used up: new streams are blocked until it resets or an admin raises it"
	case protocol.ErrorCodePresetNotAllowed:
		msg = "the room does not allow this preset: choose another with --preset"
	case protocol.ErrorCodeBitrateNotAllowed:
		msg = fmt.Sprintf("the room allows at most %s kbit/s in total: choose a lower --preset or fewer --layers", intOr(e.Limit, "a lower bitrate"))
	case protocol.ErrorCodeStreamLimitReached:
		msg = fmt.Sprintf("the room already has its maximum of %s streams", intOr(e.Limit, "its"))
	case protocol.ErrorCodeHelperBusy:
		msg = "this device already streams in this room: stop the other stream first (or wait 15 s after it was killed)"
	case protocol.ErrorCodeRtcNotConfigured:
		msg = "the instance has no Realtime (SFU) credentials configured: ask its admin"
	case protocol.ErrorCodeSFUError:
		msg = "the SFU refused the request: try again in a moment"
	case protocol.ErrorCodeSFUSessionNotFound:
		msg = "the room no longer has this publication (it was ended or never announced in time)"
	case protocol.ErrorCodeRateLimited:
		msg = fmt.Sprintf("too many requests: wait %s ms and try again", intOr(e.RetryAfterMs, "a little"))
	case protocol.ErrorCodeProtocolUnsupported:
		msg = "update required: this helper is too old for the instance"
	case protocol.ErrorCodeInvalidMessage:
		path := ""
		if e.Path != nil {
			path = " at " + *e.Path
		}
		msg = "the instance refused a request this helper sent" + path + ": please report it"
	default:
		return err
	}
	return &explained{msg: msg, err: err}
}

func explainClose(err error, code protocol.CloseCode) error {
	var msg string
	switch code {
	case protocol.CloseCodeUnauthenticated:
		msg = "the device was signed out (token revoked or expired): run openlive-helper pair again"
	case protocol.CloseCodeReplaced:
		msg = "another connection of this device took over the room"
	case protocol.CloseCodeForbidden:
		msg = "this account lost access to the room"
	case protocol.CloseCodeKicked:
		msg = "removed from the room by a moderator"
	case protocol.CloseCodeRoomClosed:
		msg = "the room was closed"
	case protocol.CloseCodeProtocolUnsupported:
		msg = "update required: this helper is too old for the instance"
	default:
		return err
	}
	return &explained{msg: msg, err: err}
}
