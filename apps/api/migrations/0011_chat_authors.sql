-- The rooms whose text chat holds a user's messages. The messages
-- themselves live in each RoomDO's SQLite; the room records here the first time someone writes,
-- so deleting the account (DELETE /api/admin/users/:userId) knows which rooms to erase them from.
CREATE TABLE chat_authors (
  room_id  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id)
);
