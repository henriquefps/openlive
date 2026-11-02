-- The mobile app's login (docs/PROTOCOL.md 11.6): the system browser signs in, the
-- person allows the app on /app/authorize, and the app exchanges a one-time code (PKCE, RFC 7636)
-- for an app token. Codes, tokens and WebSocket tickets are stored only as SHA-256 hashes.

-- An authorization code: single use, two minutes, bound to the client id, the redirect URI and
-- the PKCE challenge. The row goes when exchanged (whatever the outcome) or expired.
CREATE TABLE app_codes (
  code_hash      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client         TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  device_name    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX app_codes_expires_idx ON app_codes (expires_at);

-- An app token: the app's credential, a signed-in user on the user routes. Listed in Settings >
-- Sessions; valid until revoked or unused for 90 days (expires_at slides with use).
CREATE TABLE app_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client       TEXT NOT NULL,
  device_name  TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX app_tokens_user_idx ON app_tokens (user_id);

-- A WebSocket ticket: one upgrade of the hub, a space or a room, within a minute of being issued.
CREATE TABLE app_ws_tickets (
  ticket_hash  TEXT PRIMARY KEY,
  app_token_id TEXT NOT NULL REFERENCES app_tokens (id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX app_ws_tickets_expires_idx ON app_ws_tickets (expires_at);
