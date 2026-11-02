-- Platform user management: a platform-wide ban, and the identities it covers.

-- Set while the platform admin keeps the account banned: it cannot sign in, its sessions and
-- helpers stop working, and it is kept out of every room. banned_reason is the admin's own note.
ALTER TABLE users ADD COLUMN banned_at INTEGER;
ALTER TABLE users ADD COLUMN banned_reason TEXT;
ALTER TABLE users ADD COLUMN banned_by TEXT REFERENCES users (id) ON DELETE SET NULL;

-- The login identities of banned accounts, so a new sign-up with the same Discord account or
-- e-mail address is refused, also after the account itself was deleted. Only the SHA-256 of
-- '<provider>:<value>' is stored (the address in lower case): enough to recognise the identity
-- at login, without keeping the address of a deleted account. user_id is cleared when the
-- account is deleted; unbanning the account removes its rows.
CREATE TABLE banned_identities (
  identity_hash TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN ('discord', 'email')),
  user_id       TEXT REFERENCES users (id) ON DELETE SET NULL,
  banned_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  banned_at     INTEGER NOT NULL
);
CREATE INDEX banned_identities_user_idx ON banned_identities (user_id);
CREATE INDEX users_banned_idx ON users (banned_at) WHERE banned_at IS NOT NULL;
