-- Quick rooms by code. The code alone identifies the room, so it is unique among
-- the quick rooms that are not archived, across every space. Expired rooms that were not archived
-- yet still hold their code; creation draws another one on a collision.
--
-- Codes are stored in canonical form (OL-1234-5678). Rooms created before this migration have no
-- code: they keep working by link and expire within hours.
ALTER TABLE rooms ADD COLUMN code TEXT CHECK (code IS NULL OR kind = 'quick');
CREATE UNIQUE INDEX rooms_code_idx ON rooms (code) WHERE code IS NOT NULL AND archived_at IS NULL;
