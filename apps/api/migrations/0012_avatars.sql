-- Profile photos (Settings -> Profile). users.avatar_url stays the URL every list shows; these
-- columns remember where it came from, so a Discord login no longer overwrites a photo the person
-- chose:
--   discord_avatar_url: the last photo Discord gave at login, for "Use my Discord photo".
--   avatar_source: NULL follows Discord (the behaviour before this migration), 'upload' is a photo
--   stored in R2 under avatars/<userId> and served by GET /api/avatars/:userId/:version, 'none'
--   means the person removed their photo (initials), and Discord logins leave it alone.
ALTER TABLE users ADD COLUMN discord_avatar_url TEXT;
ALTER TABLE users ADD COLUMN avatar_source TEXT CHECK (avatar_source IN ('upload', 'none'));

UPDATE users SET discord_avatar_url = avatar_url
WHERE avatar_url LIKE 'https://cdn.discordapp.com/%';
