-- Invite-only sign-up: the invite token or room code a magic link was sent
-- for, as JSON ({"invite": "..."} or {"code": "OL-..."}). Checked again when the link is used
-- and would create an account; never consumes a use of the invite.
ALTER TABLE email_tokens ADD COLUMN signup_json TEXT;
