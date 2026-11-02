-- Interactive tutorial progress per user. The admin onboarding wizard keeps its
-- state in platform_settings (key `onboarding`), so it needs no table.

-- One row per user who has seen or skipped a screen's tutorial. seen_json is a JSON array of
-- screen ids (`spaces`, `space`, `room`, `topbar`, ...); disabled = 1 is "Don't show tutorials
-- again". No row means nothing seen yet.
CREATE TABLE user_tutorial (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  seen_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(seen_json) AND json_type(seen_json) = 'array'),
  disabled   INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);
