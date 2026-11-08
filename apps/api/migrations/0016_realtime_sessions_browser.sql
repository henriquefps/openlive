-- Browser publications (protocol 1.22, a desktop tab streams without the helper) are recorded with
-- their own kind, so their egress can be told apart when reconciling per space. SQLite cannot
-- change a CHECK constraint in place: the table is rebuilt with its rows. Nothing references it.
CREATE TABLE realtime_sessions_new (
  session_id TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  room_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  device_id  TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('publish', 'browser_publish', 'view')),
  created_at INTEGER NOT NULL
);
INSERT INTO realtime_sessions_new (session_id, space_id, room_id, user_id, device_id, kind, created_at)
  SELECT session_id, space_id, room_id, user_id, device_id, kind, created_at FROM realtime_sessions;
DROP TABLE realtime_sessions;
ALTER TABLE realtime_sessions_new RENAME TO realtime_sessions;
CREATE INDEX realtime_sessions_space_idx ON realtime_sessions (space_id, created_at);
