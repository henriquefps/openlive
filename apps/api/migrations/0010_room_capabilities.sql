-- Room capabilities: every room chooses what it has (stream,
-- voice, camera, text), stored as settings_json.capabilities. Rooms from before capabilities
-- become stream-only, which is what they were: nothing changes for the people using them. The
-- code reads a missing value the same way; this makes the choice explicit in the data.
-- Spaces and the platform need nothing: unset means "allow every capability".
UPDATE rooms
SET settings_json = json_set(
  settings_json,
  '$.capabilities',
  json('{"stream":true,"voice":false,"camera":false,"text":false}')
)
WHERE json_type(settings_json, '$.capabilities') IS NULL;
