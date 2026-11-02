-- The session cookie is now __Host-ol_session on https origins (security
-- review, L3). Sessions issued before that were sent as ol_session; legacy_cookie = 1 marks them, and
-- only they are accepted under the old name, each once: the first API call re-issues the session
-- under the new name (rotated, legacy_cookie = 0) and clears the old cookie, so nobody is signed
-- out. A session created from now on is never accepted under the old name, so a sibling
-- subdomain cannot plant one there. Every row that exists now (or that the previous Worker
-- creates until the new one is deployed) gets the default 1; the new code inserts 0.
ALTER TABLE sessions ADD COLUMN legacy_cookie INTEGER NOT NULL DEFAULT 1;
