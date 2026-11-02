-- Phase 2: helper pairing (docs/PROTOCOL.md 11.1) and the Realtime sessions the
-- RoomDOs create.

-- A pending pairing (RFC 8628 style). The helper holds the device code, the person types the user
-- code. Only the device code's SHA-256 is stored. Rows go once exchanged or expired; the device
-- and its token are only created when the approved helper polls, so no token is ever stored here.
CREATE TABLE device_codes (
  device_code_hash TEXT PRIMARY KEY,
  -- Six characters without the hyphen, upper case.
  user_code        TEXT NOT NULL UNIQUE,
  name             TEXT,
  os               TEXT NOT NULL CHECK (os IN ('linux', 'windows', 'macos')),
  arch             TEXT NOT NULL CHECK (arch IN ('amd64', 'arm64')),
  helper_version   TEXT NOT NULL,
  interval_ms      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  last_poll_at     INTEGER,
  approved_by      TEXT REFERENCES users (id) ON DELETE CASCADE,
  approved_at      INTEGER
);
CREATE INDEX device_codes_expires_idx ON device_codes (expires_at);

-- Every Realtime SFU session a RoomDO created, so real egress (per session in Cloudflare's
-- GraphQL usage) can be attributed to a space.
CREATE TABLE realtime_sessions (
  session_id TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  room_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  device_id  TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('publish', 'view')),
  created_at INTEGER NOT NULL
);
CREATE INDEX realtime_sessions_space_idx ON realtime_sessions (space_id, created_at);
