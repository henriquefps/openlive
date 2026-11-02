-- Platform admin and session rotation.

-- Set while the platform admin keeps the space suspended: nobody enters its
-- rooms or uses its API until the suspension is lifted.
ALTER TABLE spaces ADD COLUMN suspended_at INTEGER;

-- Session rotation: when a session is renewed it is copied to a new id, and the
-- old row points to its successor and expires a minute later, so requests that
-- were already in flight with the old cookie still succeed.
ALTER TABLE sessions ADD COLUMN replaced_by TEXT;
