-- Login: what the magic link carries to the verify step, and the
-- rate-limit counters for e-mail sends and install-code attempts.

-- Where to land after the link is used.
ALTER TABLE email_tokens ADD COLUMN return_to TEXT;
ALTER TABLE email_tokens ADD COLUMN created_at INTEGER;

-- One row per counted attempt. bucket is '<kind>:<subject>', where an e-mail
-- address or an IP is stored only as its HMAC (a user id as is). Rows older
-- than a day are deleted as new ones arrive.
CREATE TABLE auth_rate_events (
  bucket     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_rate_events_bucket_idx ON auth_rate_events (bucket, created_at);
CREATE INDEX auth_rate_events_created_idx ON auth_rate_events (created_at);
