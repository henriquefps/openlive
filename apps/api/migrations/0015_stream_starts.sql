-- Where and when streams started, so the mobile app (which has no push) can say "Fulano streamed
-- at 8 pm" when it opens (docs/PROTOCOL.md 11.7). Written by the room when a stream is announced;
-- rows older than 7 days are swept. Only the start is kept: no title, no viewers, no media.
CREATE TABLE stream_starts (
  stream_id  TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  room_id    TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);
CREATE INDEX stream_starts_space_idx ON stream_starts (space_id, started_at);
CREATE INDEX stream_starts_started_idx ON stream_starts (started_at);
