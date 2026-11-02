-- Real Realtime egress per UTC day, as reported by Cloudflare's GraphQL
-- Analytics. The datasets keep only 32 days, so
-- the Worker copies them here. Each row holds the day's total so far and is
-- replaced on every fetch. resource_id is the SFU appId or the TURN keyId.

CREATE TABLE usage_real_daily (
  day          TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  service      TEXT NOT NULL CHECK (service IN ('sfu', 'turn')),
  resource_id  TEXT NOT NULL,
  egress_bytes INTEGER NOT NULL CHECK (egress_bytes >= 0),
  fetched_at   INTEGER NOT NULL,
  PRIMARY KEY (day, service, resource_id)
);
