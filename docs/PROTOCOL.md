# Openlive protocol

Protocol version: **1.22**

This document is the contract between the web app, the Worker and its Durable Objects (`RoomDO`,
`UserHubDO`, `SpaceDO`) and the native helper. Change this document first, then the schema in
`packages/protocol/schema/`, then the code. The schema is the single machine-readable source:
TypeScript types and validators (`packages/protocol/src/generated/`) and Go types
(`packages/protocol/go/`) are generated from it with `pnpm generate`, and CI fails when they are
out of date. Fixtures in `packages/protocol/fixtures/` are checked by both the TypeScript and the
Go test suites, so both sides read the schema the same way.

## 1. Versioning

- A version is `major.minor`. This document describes **1.22**.
- 1.1 adds the REST bodies of device pairing and the SFU proxy (`packages/protocol/schema/rest.json`,
  section 11) and their error codes; no message changed.
- 1.2 adds the optional `encoder` and `layers[]` (per simulcast layer) to `helper.stats`.
- 1.3 adds the optional `restored` to `SourceDescriptor` (`helper.sources`).
- 1.4 adds the REST error codes `signup_invite_required`, `space_creation_restricted` and
  `user_not_removable` (invite-only sign-up and the space creation policy); no message changed.
- 1.5 adds the REST error codes `account_banned`, `cannot_target_self` and
  `last_platform_admin` and the `spaceIds` error parameter (platform user management); no
  message changed. `user_not_removable` is no longer sent.
- 1.6 adds stream thumbnails and economy mode: the optional `thumbnailAt` and `qualityCap` in
  `StreamInfo`, the optional `qualityCap` in `PublishResponse`, the error code `stream_paused`
  and the thumbnail routes of section 11.3.
- 1.7 adds the optional `capturedFps`, `cpuPct`, `keyframeRequests` and `idrBytes` to
  `helper.stats`, and the REST body `ViewerMetricsRequest` (section 11.4).
- 1.8 adds the `Preset` values `game120` (1080p120) and `max120` (1440p120).
  The web only offers them to a helper that announced 1.8 or later (`HelperInfo.protocol`); the
  web itself ships with the Worker, and the Go helper reads an unknown preset in
  `allowedPresets` or `StreamInfo` as an opaque string.
- 1.9 adds room capabilities: the optional `capabilities` in
  `RoomSettings` (`Capability`, `RoomCapabilities`), the message `room.updated`, the error code
  `capability_disabled` and its `capability` parameter. `room.updated` goes to web connections
  only (the web ships with the Worker); a helper before 1.9 reads `capability_disabled` as an
  unknown code string.
- 1.10 adds the voice channel (section 7.5): the messages
  `voice.join`, `voice.joined`, `voice.leave`, `voice.left`, `voice.state`, `voice.updated`,
  `voice.tracks`, `voice.serverMute` and `voice.kick` (web connections only), the optional
  `welcome.voice`, `Permissions.canJoinVoice` / `canSpeak` and `RoomSettings.maxVoiceParticipants`
  / `guestsCanSpeak`, the types `VoiceParticipant`, `VoiceTrack` and `VoiceLeftReason`, the error
  codes `voice_full`, `voice_speak_not_allowed`, `voice_not_joined` and `voice_track_not_found`
  with the `trackId` parameter, and the voice routes of the SFU proxy (section 11.2). A room
  without voice answers voice messages with `capability_disabled { capability: voice }` (no
  separate `voice_disabled` code).
- 1.11 adds the text chat (section 7.6): the messages
  `chat.send`, `chat.message`, `chat.edit`, `chat.edited`, `chat.delete`, `chat.deleted`,
  `chat.history`, `chat.page` and `chat.read` (web connections only), the optional
  `welcome.chat` (`ChatSummary`), `Permissions.canReadChat` / `canWriteChat`,
  `RoomSettings.chatRetentionDays` (`ChatRetentionDays`) / `guestsCanWrite`, the type
  `ChatMessage`, the error codes `chat_message_too_long`, `chat_write_not_allowed` and
  `chat_message_not_found` with the `messageId` parameter, and the notice event `chat_mention`. A
  room without text answers chat messages with `capability_disabled { capability: text }`.
- 1.12 adds cameras in the voice channel (section 7.7): the
  optional `voice.tracks.cameras` (`CameraTrack`), `VoiceParticipant.camera`,
  `Permissions.canUseCamera`, `RoomSettings.maxCameras` / `guestsCanUseCamera`, the messages
  `voice.cameraOff` and `voice.cameraStopped` (web connections only) with `CameraStopReason`, the
  error codes `camera_not_allowed` and `camera_limit_reached`, and the camera routes of the SFU
  proxy (section 11.2). A room without the camera capability answers camera messages and routes
  with `capability_disabled { capability: camera }`.
- 1.13 adds room presence in the space sidebar (section 7.8): the endpoint `GET /ws/spaces/:spaceId`
  (`SpaceDO`), the messages `space.presence` and `space.presence.updated` (web connections only),
  the types `RoomPresence`, `VoicePresence` and `LivePresence`, and `space.presence` as a reply to
  `hello`. Rooms and hub are unchanged.
- 1.14 adds AV1 streams (section 11.2): the type `VideoCodec`,
  the optional `Track.codec` / `PublishTrack.codec` (a stream's second video track, its top layer
  in AV1, without rids), `RoomSettings.av1Presets` (the presets that publish it, set by the
  platform admin), and the optional `SubscribeRequest.codec` / `SubscribeResponse.codec`. A viewer
  that asks for `av1` on the top layer pulls the AV1 track where the room allows it, H.264
  otherwise; older clients, which ask for nothing, keep H.264.
- 1.15 adds the error code `do_quota_exceeded` (`503`, REST and refused WebSocket upgrades): the
  instance hit a daily Cloudflare free-tier limit of Durable Objects. The viewer
  slot lease becomes 90 s (`leaseMs` says so; clients already renew every `leaseMs / 3`).
- 1.16 adds the helper's voice sink (section 8.4):
  the optional `helper.status.voiceSink` (`VoiceSink`), `HelperStreamStatus.audioApp`
  (`HelperAudioApp`, `BrowserFamily`) and the command `helper.setVoiceOutput`. The web sends it
  only to a helper that announced 1.16 or later; an older helper answers `unknown_message_type`.
- 1.17 adds AV1 modes: the optional `RoomSettings.av1QualityPresets`,
  the presets among `av1Presets` whose AV1 track sends as much as the H.264 top layer ("AV1:
  quality"); the others save data at about 65 % of it, as in 1.14. A helper before 1.17 ignores it
  and sends every AV1 track at the data-saving rate; the Worker meters an AV1 viewer at the rate of
  the stream's preset mode.
- 1.18 adds the mobile app's login (section 11.6): the
  instance description `GET /.well-known/openlive.json` (`InstanceInfo`, `ProtocolRange`), the
  routes `/api/app/authorize`, `/api/app/token` and `/api/app/ws-ticket` (`AppAuthorizeRequest`,
  `AppAuthorizeResponse`, `AppTokenRequest`, `AppTokenResponse`, `AppUser`,
  `AppWsTicketResponse`), the error code `app_code_invalid`, the `?ticket=` query of the three
  socket endpoints, and the `kind` of the entries of `GET /api/me/sessions`. No message changed.
- 1.19 adds the layers a stream really encodes: the optional `layers` (`VideoLayers`, `VideoLayer`:
  rid, width, height, fps and target kbps) on `stream.announce`, `stream.update` and `StreamInfo`
  (section 7.2). A native stream of a 3440x1440 monitor is 3440x1440, not the preset's 3840x2160.
  Clients label layers and size their estimates from it, and fall back to the preset's nominal
  layers when it is absent (a helper before 1.19).
- 1.20 adds visual pointer pings (section 7.9): the optional
  `pings` and `pingOverlay` in `StreamInfo`, the optional `pingOverlay` in `stream.announce`, the
  messages `stream.setPings`, `pointer.ping` and `pointer.pinged` (with `PointerStyle`,
  `PointerColor`, `PointerShape`) and the error code `pings_disabled`. A helper before 1.20 never
  announces `pingOverlay`, so it never gets `pointer.pinged`.
- 1.21 adds global voice shortcuts through the helper (section 8.5): the message
  `helper.voiceShortcut` (helper → hub → web tabs) and `VoiceShortcutAction`. A helper before 1.21
  never sends it.
- 1.22 adds streaming from the browser, a fallback with limited quality
  (sections 7.2 and 11.2): the routes
  `POST .../browser/publish` (`BrowserPublishRequest`), `PUT .../browser/publish/renegotiate` and
  `POST .../browser/unpublish`, the optional `StreamInfo.origin` (`StreamOrigin`: `helper` or
  `browser`; absent means `helper`), the error code `browser_stream_busy`, `stream.announce`,
  `stream.update` and `stream.end` from the web tab that owns a browser publication, `stream.stop`
  to that tab, and the thumbnail upload from a browser stream's owner. A browser stream ends with
  the existing reasons (`helper_disconnected` when its tab is gone), so `stream.ended` stays
  readable by a helper before 1.22.
- Within a major version, changes are **additive only**: new message types, new optional fields,
  new enum values, new error codes. Nothing is removed, renamed, made required or given a new
  meaning. Each addition bumps the minor version and is marked "since 1.x" here.
- Anything else is a new major version. The server may support several majors at once;
  `welcome.minProtocol` tells clients the oldest one it still accepts.
- Receivers **ignore unknown properties**. The generated TypeScript validators remove them before
  validating the rest; Go's `encoding/json` ignores them.
- Receivers **ignore messages of unknown type**. If such a message carries an `id`, the server
  answers `error` with `unknown_message_type`.
- A sender does not send a message type or enum value newer than the peer's announced minor
  version (`hello.protocol` for the server, `welcome.protocol` / `hub.welcome.protocol` for
  clients), because an older peer would reject the enum value or ignore the message.

## 2. Transport

| Endpoint                  | Durable Object             | Who connects                                      | Authentication at the upgrade                                       |
| ------------------------- | -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /ws/rooms/:roomId`   | `RoomDO` (one per room)    | web tabs and helpers in the room                  | web: session cookie; helper: `Authorization: Bearer <device token>` |
| `GET /ws/hub`             | `UserHubDO` (one per user) | the user's web tabs and paired helpers            | same as above                                                       |
| `GET /ws/spaces/:spaceId` | `SpaceDO` (one per space)  | web tabs showing the space's sidebar (since 1.13) | web: session cookie; the caller must be able to view the space      |

- Authentication and the room access check happen on the HTTP upgrade, never inside messages.
  The helper authenticates with the device token it got from pairing (section 11.1); the same
  header works on every REST route.
  A refused upgrade gets an HTTP error with a JSON error body (section 6).
- One frame = one UTF-8 JSON text message = one envelope. Binary frames are not used.
- Frames are at most 512 KiB. The largest message is `helper.sourceThumbnail` (≤ 256 KiB of base64).
- Every DO uses the WebSocket Hibernation API.

## 3. Envelope

```json
{ "type": "slot.request", "id": "7", "payload": { "streamId": "st_1" } }
```

| Field     | Required | Meaning                                                                                 |
| --------- | -------- | --------------------------------------------------------------------------------------- |
| `type`    | yes      | Message type, dotted lower camel case (`stream.setViewerLimit`).                        |
| `id`      | no       | 1–64 characters chosen by the sender of a **request**. The reply carries the same `id`. |
| `payload` | yes      | Object; `{}` when the message has no fields.                                            |

Request and reply:

- A client message sent with an `id` gets **exactly one** reply with that `id`: the reply type
  listed in the catalogue, or `error`. Where the catalogue lists `ack`, success is `ack {}`.
- A client message without `id` gets no reply on success; a failure is still reported as `error`
  without `id`.
- Server messages without `id` are events. A reply can double as an event: `stream.started` goes
  to everyone in the room, and to the announcing helper with its request `id`.
- Ids are only unique per connection and per direction. The `UserHubDO` rewrites ids when it relays
  between a web tab and a helper (section 8.2), so each side only sees its own ids.

## 4. Handshake

The first client message on every connection is `hello`:

```json
{
  "type": "hello",
  "id": "1",
  "payload": {
    "protocol": { "major": 1, "minor": 0 },
    "client": "helper",
    "clientVersion": "0.1.0",
    "deviceId": "d_pc"
  }
}
```

- `client` is `web` or `helper`. A helper must send its `deviceId`, which must match its token. A
  web tab sends a `tabId`: a random id it creates when it opens and keeps for its lifetime.
- A connection made with a device token must say `client: "helper"` with the token's `deviceId`,
  and only such a connection may say `helper`. Anything else gets `error unauthenticated`, then
  close **4001**.
- The room answers `welcome`, the hub answers `hub.welcome`, both with the server's `protocol`,
  `minProtocol` and `serverTime` (to correct lease and expiry times for clock skew).
- If the major version is not supported: `error { "code": "protocol_unsupported", "minProtocol",
"maxProtocol" }`, then close with **4006**. The web shows "please reload"; the helper shows
  "update required".
- Any other message before `hello` gets `error hello_required`.
- A second connection of the same client (same user and same `tabId`, or same `deviceId`) to the
  same DO replaces the first one, which is closed with **4002**. A web connection without `tabId`
  never replaces another one.

Keepalive: clients send exactly `{"type":"ping","payload":{}}` (no `id`, no spaces); the DO answers
`{"type":"pong","payload":{}}` through `setWebSocketAutoResponse`, without waking up. These strings
are exported as `PING_FRAME` and `PONG_FRAME`. Send a ping every 30 s.

## 5. Close codes

| Code | Name                  | Meaning                                                                   | Preceded by                                 |
| ---- | --------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| 1000 | `Normal`              | Normal close.                                                             | —                                           |
| 4001 | `Unauthenticated`     | Not authenticated, or the session or device token expired or was revoked. | `error unauthenticated` / `session_expired` |
| 4002 | `Replaced`            | A newer connection of the same client took over.                          | —                                           |
| 4003 | `Forbidden`           | No permission for this room (access removed while connected).             | `error forbidden`                           |
| 4004 | `Kicked`              | Removed, banned or demoted by an admin.                                   | `kicked`                                    |
| 4005 | `RoomClosed`          | The room was closed, archived, deleted or expired.                        | `room.closed`                               |
| 4006 | `ProtocolUnsupported` | The client's major protocol version is not supported.                     | `error protocol_unsupported`                |

Clients reconnect with backoff after an abnormal close (1006) or 1000 sent during a deploy. After
4001–4006 they do not reconnect automatically (a tab closed with 4002 stays idle until the user
brings it back).

## 6. Errors and codes, never text

The server never sends user-facing text. Errors and events are codes with parameters, and the web
and the helper translate them:

```json
{
  "type": "error",
  "id": "7",
  "payload": { "code": "viewer_limit_reached", "streamId": "st_1", "limit": 6, "used": 6 }
}
```

The same flat object (`ErrorPayload`) is the body of every REST error response, with the matching
HTTP status. Parameters are optional fields of `ErrorPayload`; each code always sends the ones
listed here.

| Code                         | HTTP | Parameters                   | When                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthenticated`            | 401  | —                            | No session or device token. Close 4001 on a socket.                                                                                                                                                                                                                                               |
| `session_expired`            | 401  | —                            | The session or device token expired or was revoked. Close 4001.                                                                                                                                                                                                                                   |
| `forbidden`                  | 403  | `roomId`?, `spaceId`?        | `can()` refused the action.                                                                                                                                                                                                                                                                       |
| `hello_required`             | —    | `messageType`                | A message arrived before `hello`.                                                                                                                                                                                                                                                                 |
| `protocol_unsupported`       | 400  | `minProtocol`, `maxProtocol` | Unsupported major version. Close 4006.                                                                                                                                                                                                                                                            |
| `invalid_message`            | 400  | `path`                       | Not JSON, or fails the schema. `path` is a JSON Pointer into the message (`/payload/streamId`); empty when the frame is not JSON.                                                                                                                                                                 |
| `unknown_message_type`       | —    | `messageType`                | Type unknown to this server, and the message had an `id`.                                                                                                                                                                                                                                         |
| `rate_limited`               | 429  | `retryAfterMs`               | Too many messages or requests.                                                                                                                                                                                                                                                                    |
| `internal_error`             | 500  | —                            | Bug or dependency failure; safe to retry once.                                                                                                                                                                                                                                                    |
| `room_not_found`             | 404  | `roomId`                     |                                                                                                                                                                                                                                                                                                   |
| `room_closed`                | 410  | `roomId`                     | The room is closed or expired.                                                                                                                                                                                                                                                                    |
| `stream_not_found`           | 404  | `streamId`                   | Unknown or already ended.                                                                                                                                                                                                                                                                         |
| `stream_permission_required` | 403  | `roomId`                     | Publishing without the permission to stream.                                                                                                                                                                                                                                                      |
| `stream_limit_reached`       | 409  | `limit`                      | The room already has its maximum of simultaneous streams.                                                                                                                                                                                                                                         |
| `pings_disabled`             | 403  | `streamId`                   | Since 1.20. `pointer.ping` on a stream whose streamer has not allowed pings (section 7.9).                                                                                                                                                                                                        |
| `stream_paused`              | 409  | `streamId`                   | Since 1.6. A thumbnail upload during the privacy curtain or a pause that is not the paused placeholder (section 11.3).                                                                                                                                                                            |
| `preset_not_allowed`         | 403  | `preset`                     | The preset is above the room's limits.                                                                                                                                                                                                                                                            |
| `capability_disabled`        | 403  | `capability`                 | Since 1.9. The room does not have this capability (section 7.4), for example a stream message in a voice-only room.                                                                                                                                                                               |
| `viewer_limit_reached`       | 409  | `streamId`, `limit`, `used`  | No free viewer slot; the client may `queue.join`.                                                                                                                                                                                                                                                 |
| `viewer_limit_too_high`      | 400  | `streamId`, `limit`          | `stream.setViewerLimit` above what the room and platform allow; `limit` is the highest allowed.                                                                                                                                                                                                   |
| `slot_not_found`             | 404  | `slotId`                     | The slot expired or was released; request a new one.                                                                                                                                                                                                                                              |
| `offer_not_found`            | 410  | `offerId`                    | The queue offer expired or was taken.                                                                                                                                                                                                                                                             |
| `quota_exhausted`            | 403  | —                            | The space's monthly bandwidth quota is used up.                                                                                                                                                                                                                                                   |
| `helper_offline`             | 409  | `deviceId`                   | The target helper is not connected to the hub.                                                                                                                                                                                                                                                    |
| `browser_stream_busy`        | 409  | `roomId`                     | Since 1.22. `POST .../browser/publish`: the caller already streams (or is publishing) from a browser tab in this room; one per user per room.                                                                                                                                                     |
| `helper_busy`                | 409  | `deviceId`                   | The helper is already streaming (possibly on another instance).                                                                                                                                                                                                                                   |
| `source_not_found`           | 404  | `sourceId`                   | The source disappeared since `helper.sources`.                                                                                                                                                                                                                                                    |
| `not_found`                  | 404  | —                            | REST: no such route.                                                                                                                                                                                                                                                                              |
| `space_not_found`            | 404  | `spaceId`                    | Unknown or deleted space, or the caller is not a member and may not know it exists.                                                                                                                                                                                                               |
| `member_not_found`           | 404  | `userId`                     | The user is not a member of the space.                                                                                                                                                                                                                                                            |
| `user_not_found`             | 404  | `userId`                     | Unknown or deleted user.                                                                                                                                                                                                                                                                          |
| `slug_taken`                 | 409  | `slug`                       | Another space (or another room of the space) already uses this slug.                                                                                                                                                                                                                              |
| `already_member`             | 409  | —                            | Accepting an invite that would give nothing new: already a member with that role, or already able to view the room.                                                                                                                                                                               |
| `banned`                     | 403  | `spaceId`                    | The caller is banned from the space (accepting an invite, for example).                                                                                                                                                                                                                           |
| `owner_must_transfer`        | 409  | `spaceId` / `spaceIds`       | The owner cannot leave the space; transfer the ownership first. From `DELETE /api/admin/users/:userId`: `spaceIds`, every space it owns.                                                                                                                                                          |
| `setting_above_ceiling`      | 400  | `path`, `limit`              | A space or room limit above the level above it. `path` is the JSON Pointer of the field, `limit` the highest allowed value.                                                                                                                                                                       |
| `invite_not_found`           | 404  | `inviteId`?                  | Unknown invite token or id.                                                                                                                                                                                                                                                                       |
| `invite_expired`             | 410  | —                            | The invite expired.                                                                                                                                                                                                                                                                               |
| `invite_revoked`             | 410  | —                            | The invite was revoked.                                                                                                                                                                                                                                                                           |
| `invite_exhausted`           | 410  | —                            | The invite reached its maximum number of uses.                                                                                                                                                                                                                                                    |
| `join_request_not_found`     | 404  | `joinRequestId`              |                                                                                                                                                                                                                                                                                                   |
| `join_request_decided`       | 409  | `joinRequestId`              | The join request was already approved, rejected or cancelled.                                                                                                                                                                                                                                     |
| `origin_not_allowed`         | 403  | —                            | A state-changing REST request (or a room socket) from an origin that is not the app (CSRF check).                                                                                                                                                                                                 |
| `auth_not_configured`        | 503  | —                            | The login method is not set up on this instance (missing Discord, Resend or session secret).                                                                                                                                                                                                      |
| `oauth_state_invalid`        | 400  | —                            | Discord login: the `state` or the PKCE cookie is missing, expired or does not match. Sent as `?authError=` on the redirect to the app.                                                                                                                                                            |
| `oauth_failed`               | 502  | —                            | Discord login was cancelled or Discord refused the code. Sent as `?authError=` on the redirect.                                                                                                                                                                                                   |
| `magic_link_invalid`         | 410  | —                            | The e-mail link is unknown, expired or already used. Sent as `?authError=` on the redirect.                                                                                                                                                                                                       |
| `email_send_failed`          | 502  | —                            | The e-mail provider did not accept the magic-link message.                                                                                                                                                                                                                                        |
| `session_not_found`          | 404  | `sessionId`                  | Not one of the caller's active sessions.                                                                                                                                                                                                                                                          |
| `admin_claim_unavailable`    | 403  | —                            | No install code is set, so nobody can claim the platform admin role.                                                                                                                                                                                                                              |
| `admin_already_claimed`      | 409  | —                            | The instance already has a platform admin.                                                                                                                                                                                                                                                        |
| `install_code_invalid`       | 403  | —                            | The install code does not match.                                                                                                                                                                                                                                                                  |
| `space_suspended`            | 403  | `spaceId` / `roomId`         | The platform admin suspended the space: its REST routes and rooms are closed until lifted.                                                                                                                                                                                                        |
| `room_code_invalid`          | 404  | —                            | `POST /api/rooms/join`: no quick room has this code (`400` when the text cannot be a code).                                                                                                                                                                                                       |
| `authorization_pending`      | 400  | —                            | Since 1.1. `POST /api/devices/token`: nobody approved the code yet; poll again after `intervalMs`.                                                                                                                                                                                                |
| `slow_down`                  | 400  | `intervalMs`                 | Since 1.1. Polled faster than the interval; the interval grows by 5 s and `intervalMs` is the new one.                                                                                                                                                                                            |
| `expired_token`              | 400  | —                            | Since 1.1. The device code expired or was already exchanged; start pairing again.                                                                                                                                                                                                                 |
| `device_code_invalid`        | 404  | —                            | Since 1.1. `/link`: no pending pairing has this user code (unknown, expired or already approved).                                                                                                                                                                                                 |
| `device_not_found`           | 404  | `deviceId`                   | Since 1.1. Not one of the caller's paired devices.                                                                                                                                                                                                                                                |
| `app_code_invalid`           | 400  | —                            | Since 1.18. `POST /api/app/token`: the code is unknown, used or expired, the verifier does not match, or another client or redirect URI.                                                                                                                                                          |
| `rtc_not_configured`         | 503  | —                            | Since 1.1. The Realtime app or TURN key is not set up on this instance.                                                                                                                                                                                                                           |
| `sfu_error`                  | 502  | —                            | Since 1.1. The SFU refused the call (HTTP error, top-level or per-track `errorCode`). Safe to retry once; the SFU's text is never forwarded.                                                                                                                                                      |
| `sfu_session_not_found`      | 404  | `sessionId`                  | Since 1.1. The SFU session is not the caller's in this room (or was closed). For a viewer: open a new one with `POST .../session`.                                                                                                                                                                |
| `bitrate_not_allowed`        | 403  | `limit`                      | Since 1.1. `maxBitrateKbps` above the room's limit; `limit` is the highest allowed.                                                                                                                                                                                                               |
| `signup_invite_required`     | 403  | —                            | Since 1.4. Invite-only sign-up: a login would create an account without a valid invite or room code. Sent as `?authError=` on the redirect.                                                                                                                                                       |
| `space_creation_restricted`  | 403  | —                            | Since 1.4. `POST /api/spaces`: only the platform admin creates spaces on this instance (platform setting `spaceCreation`).                                                                                                                                                                        |
| `user_not_removable`         | 409  | `userId`                     | Since 1.4, no longer sent since 1.5 (`DELETE /api/admin/users/:userId` now deletes any account but its guards below).                                                                                                                                                                             |
| `account_banned`             | 403  | —                            | Since 1.5. The account (or its Discord account or e-mail address) is banned from the instance. Sent as `?authError=` on the login redirect.                                                                                                                                                       |
| `cannot_target_self`         | 409  | `userId`                     | Since 1.5. The platform admin cannot ban or delete their own account.                                                                                                                                                                                                                             |
| `last_platform_admin`        | 409  | `userId`                     | Since 1.5. The instance would be left without a platform admin.                                                                                                                                                                                                                                   |
| `voice_full`                 | 409  | `limit`                      | Since 1.10. The voice channel already has `maxVoiceParticipants` people.                                                                                                                                                                                                                          |
| `voice_speak_not_allowed`    | 403  | —                            | Since 1.10. Unmuting or publishing a microphone without `canSpeak` (a guest where `guestsCanSpeak` is false), or while server-muted.                                                                                                                                                              |
| `voice_not_joined`           | 409  | `userId`?                    | Since 1.10. Not in the voice channel: yours (no parameter) for `voice.state` and the voice routes, the target's (`userId`) for moderation.                                                                                                                                                        |
| `voice_track_not_found`      | 404  | `trackId`                    | Since 1.10. `voice/subscribe`, `camera/subscribe` and `camera/layer` (1.12): not in your `voice.tracks` (left, unpublished, your own).                                                                                                                                                            |
| `chat_message_too_long`      | 400  | `limit`                      | Since 1.11. `chat.send` / `chat.edit` above `limit` (2,000) characters, counted in code points after trimming.                                                                                                                                                                                    |
| `chat_write_not_allowed`     | 403  | —                            | Since 1.11. Sending or editing without `canWriteChat` (a guest where `guestsCanWrite` is false).                                                                                                                                                                                                  |
| `chat_message_not_found`     | 404  | `messageId`                  | Since 1.11. `chat.edit` / `chat.delete` / `chat.read`: no such message (deleted, expired by retention, or never existed).                                                                                                                                                                         |
| `do_quota_exceeded`          | 503  | —                            | Since 1.15. A Durable Objects free-tier daily limit is used up (reset documented 00:00 UTC, up to 24 h). With `reason: limits_brake` (and `releasesAt`, ms; the socket closes 1013 with reason `limits_brake`) the instance's own limits brake paused it before the limit; clients wait the same. |
| `camera_not_allowed`         | 403  | —                            | Since 1.12. `camera/publish` without `canUseCamera`: a guest where `guestsCanUseCamera` is false (the default).                                                                                                                                                                                   |
| `camera_limit_reached`       | 409  | `limit`                      | Since 1.12. `camera/publish`: the room already has `maxCameras` cameras on (default 6); your own does not count.                                                                                                                                                                                  |

Reasons carried by events are closed enums too:

| Enum                  | Values                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StreamEndReason`     | `ended_by_streamer`, `ended_by_moderator`, `helper_disconnected` (after the 15 s grace period; also a browser stream's tab, since 1.22), `permission_revoked`, `room_closed`, `quota_exhausted` |
| `SlotReleaseReason`   | `released`, `lease_expired`, `stream_ended`, `access_revoked`                                                                                                                                   |
| `QueueLeftReason`     | `left`, `offer_expired`, `stream_ended`, `access_revoked`                                                                                                                                       |
| `KickReason`          | `removed`, `banned`, `access_revoked`, `role_changed`                                                                                                                                           |
| `RoomCloseReason`     | `expired`, `ended_by_owner`, `archived`, `deleted`, `quota_exhausted`, `suspended`                                                                                                              |
| `VoiceLeftReason`     | `left`, `disconnected`, `moved`, `kicked`, `removed`, `capability_disabled` (since 1.10, section 7.5)                                                                                           |
| `CameraStopReason`    | `moderator`, `quota_exhausted`, `capability_disabled`, `not_allowed`, `limit` (since 1.12, section 7.7)                                                                                         |
| `EventCode` (notices) | `stream_started_in_room`, `viewer_joined_your_stream`, `your_stream_dropped`, `your_network_unstable`, `chat_mention` (since 1.11, section 7.6)                                                 |

## 7. Room (`RoomDO`)

### 7.1 Presence and permissions

- After `hello`, `welcome` carries `you` (user, connection, role, permissions), the `room`, its
  effective `settings` (already reduced by the platform and space ceilings), the present
  `members` and the live `streams`.
- Presence is per user: `member.joined` when a user's first connection opens, `member.left` when
  the last one closes, `member.updated` when a present user's role or stream permission changes.
- `permissions.changed` tells a connection its own role or permissions changed (the Worker
  notifies the DO when D1 changes). It applies at once: a revoked stream
  permission also ends the stream (`stream.stop` to the helper, `stream.ended` to everyone).
- Removal, ban or demotion out of the room: `kicked { reason }`, then close **4004**. Losing view
  access to a restricted room without being removed from the space: close **4003**.
- Quick rooms: `room.expiring { expiresAt }` when an expiry is scheduled or moved while someone is
  connected (for example 10 minutes before the 12 h hard limit); `room.closed { reason }` then
  close **4005** for everyone.
- `room.updated { settings }` (since 1.9, web only) when the room's effective settings change while someone
  is connected: its capabilities or limits, changed on the room, its space or the platform. The
  client re-renders the room from the new `settings`.

### 7.2 Streams

1. The helper creates its SFU session through `POST /api/rtc/rooms/:id/publish` and pushes its tracks.
2. It sends `stream.announce` with the SFU session id, source, preset and tracks, on the room
   socket of the same device, within `announceWithinMs` (60 s) of the publish, or the publication
   is closed. The room checks that the session is that device's publication, that every announced
   track was published (same name, kind and rids), the permission to stream, the preset and the
   room's stream limit, stores the stream, replies `stream.started` (with the request `id`) and
   broadcasts `stream.started` to everyone else. Errors: `forbidden` (not a helper),
   `sfu_session_not_found`, `invalid_message` (`path` at the track), `stream_permission_required`,
   `preset_not_allowed`, `stream_limit_reached`.
3. `stream.update` reports pause (`source_hidden`, `privacy_curtain`) or a new preset; everyone
   gets `stream.updated` with the full `StreamInfo`. `pauseReason` is dropped when `paused` is false.
   Since 1.19 `stream.announce` carries `layers`, the simulcast layers of the H.264 video track as
   encoded (the source's aspect ratio, the display's frame rate cap, the room's bitrate cap), and a
   `stream.update` with a new preset carries the new ones; the room keeps them in `StreamInfo.layers`.
   A `stream.update` with a new preset and no `layers` drops the old ones.
4. `stream.end` from the helper, `POST /api/rtc/rooms/:id/unpublish`, or `stream.terminate` from
   the web ends it. `stream.terminate` is allowed on one's own stream, and with `canModerate` on
   others' streams under the same rule as removing someone (an admin cannot end the owner's or
   another admin's stream: `forbidden`). For `stream.terminate` the room sends `stream.stop` to
   the helper. Everyone gets `stream.ended { reason }`.
5. If the helper's socket drops, the stream survives 15 s; a helper of the same device that says
   `hello` again within that time keeps it. After that it ends with `helper_disconnected`.
6. Other ends: a revoked stream permission (`permission_revoked`, with `stream.stop`), the room
   closing (`room_closed`), a revoked device (its sockets close with 4001, its streams end with
   `helper_disconnected` at once), and the quota brake (`quota_exhausted`, below).
7. When a stream ends, its slots and queue are dropped without `slot.released` / `queue.left`
   (`stream.ended` implies them), and the room closes its SFU tracks (`tracks/close`, `force`).

The streamer (or a moderator, same rule as `stream.terminate`) sets the stream's viewer limit with
`stream.setViewerLimit`; a helper may only set its own stream's.

**Streams from the browser** (since 1.22). A desktop web
tab may stream in place of a helper, with limited quality: it publishes through
`POST .../browser/publish` (section 11.2) and then plays the helper's part above **on its own room
socket**, the one whose `hello.tabId` is the publication's `tabId`:

- `stream.announce`, `stream.update` and `stream.end` are accepted from a web connection that owns
  the browser publication or stream (same user, same `tabId`), with the same validation and the
  same `announceWithinMs`; from any other web connection they answer `forbidden` as before. A
  browser stream's preset is `text` or `game` at most (1080p60, no 120 fps), also on
  `stream.update` (`preset_not_allowed`).
- The room stores it with `origin: "browser"` in `StreamInfo` and a `deviceId` of its own, which
  names no paired device (an opaque id, as always).
- Wherever the room sends `stream.stop` to a helper (terminate, moderation, revoked permission,
  room closed, stream capability off, quota brake), it sends it to the owning tab.
- If the owning tab's socket drops, the stream survives 15 s, exactly as a helper's: a connection
  of the same tab (`tabId`) that says `hello` again within that time keeps it. After that it ends
  with `helper_disconnected`.
- Pings (section 7.9) are never offered: a browser stream does not announce `pingOverlay`.

**Usage meter**. While slots are held, the room accumulates
viewer-seconds at the bitrate of the layer each viewer pulled (the publish's `maxBitrateKbps` for
the top layer, ~4 Mbps for the middle, ~1.2 Mbps for the low one, never above the top), plus one
join per `subscribe`, and stream-seconds per live stream. An alarm flushes the estimate to
`usage_daily` every 5 minutes (the room tick, every minute before 1.15) and when a
stream ends. **Quota brake** (brake 4): `publish` refuses
new streams with `quota_exhausted` while the instance's quota state blocks them; running streams
end with `quota_exhausted` after the grace period (10 minutes) counted from the first flush that
saw the block.

**Economy mode** (brake 3, since 1.6). While the instance's quota state is in economy mode (usage
above 90 % of the monthly limit, unless the admin turned it off), every `StreamInfo`
carries `qualityCap { maxHeight: 1080, maxBitrateKbps: 8000 }` and `POST .../publish` answers with
the same `qualityCap`. The helper fits its preset under it before `stream.announce` (the highest
allowed preset whose top layer is at most `maxHeight` tall) and caps its bitrate; when the cap
appears on a running stream (`stream.updated`) it switches preset and bitrate live, and when the
cap goes away it returns to the preset the streamer chose. Viewers start new pulls on the middle
layer (`subscribe` without `rid` picks it too); they may still pick another layer by hand. The
room re-reads the quota state at every meter flush (every 5 minutes while streams are live) and
broadcasts `stream.updated` for every stream when the mode changes.

**Thumbnails** (since 1.6). `thumbnailAt` is the time the stream's latest
thumbnail was stored, and its version; it is absent while there is none. The room bumps it (with
`stream.updated`) on every accepted upload, drops it the moment the stream pauses (the stored image
is deleted with it), and deletes the image when the stream ends. See section 11.3.

`StreamInfo` never contains the SFU session or track names. Viewers never see them at all: the
Worker pulls the tracks onto the viewer's own SFU session for a viewer holding a slot, and the
response of `POST /api/rtc/rooms/:id/subscribe` carries only the new `mid`s.

### 7.3 Viewer slots and queue

Watching a stream needs a **slot**. The room counts slots exactly because the DO handles one event
at a time.

1. `slot.request { streamId }` → `slot.granted { slotId, streamId, expiresAt, leaseMs }`, or
   `error viewer_limit_reached { limit, used }`.
2. The client passes `slotId` to `POST /api/rtc/rooms/:id/subscribe`; the Worker asks the room
   whether the slot is held by this user before creating the SFU receiving session.
3. **Lease heartbeat:** `slot.renew { slotId }` every `leaseMs / 3` (lease 90 s since 1.15, so
   every 30 s; it was 30 s) → `slot.renewed { expiresAt }`. Without renewals the slot is released
   about `leaseMs` after the last one (up to 5 minutes later when nobody is queued and nothing else
   happens in the room), and the client gets
   `slot.released { reason: "lease_expired" }` if still connected.
4. `slot.release { slotId }` → `slot.released { reason: "released" }`. Closing the socket releases
   all its slots at once. When a stream ends, its slots are released implicitly by `stream.ended`.
5. Every change is broadcast as `viewers { streamId, viewerUserIds, used, limit, queueLength }`.
   Multi-view holds one slot per watched stream. Holding a slot is not needed to see a stream's
   thumbnail.

When the stream is full:

1. `queue.join { streamId }` → `queue.position { position, length }` (or `slot.granted` straight
   away if a slot became free). Members go before guests; within a role, first come first served.
2. `queue.position` is sent again whenever the position changes.
3. When a slot frees, the first in line gets `queue.offer { offerId, expiresAt }` and has 30 s to
   send `queue.accept { offerId }` → `slot.granted`. If not, it gets `queue.left { reason:
"offer_expired" }` and the offer moves to the next in line.
4. `queue.leave { streamId }` → `ack` (idempotent). `queue.left` is only sent for the other reasons.

The streamer (or a moderator) can raise or lower the stream's limit with
`stream.setViewerLimit { streamId, limit }`, never above the room limit and the platform ceiling
(`viewer_limit_too_high`). Lowering below `used` keeps current viewers and blocks new ones.

### 7.4 Room capabilities (since 1.9)

`RoomSettings.capabilities` says what the room has: `stream` (the stream grid and player),
`voice`, `camera` (only with voice) and `text`. At least one of `stream`, `voice` and `text` is
on. It is the room's own choice reduced by what the space and the platform allow. A server before
1.9 does not send it: such a room is stream-only.

- In a room without `stream`, every stream message (`slot.*`, `queue.*`, `stream.announce`,
  `stream.update`, `stream.end`, `stream.setViewerLimit`, `stream.terminate`) is answered with
  `error { code: capability_disabled, capability: stream }`, and the SFU proxy refuses the routes
  that open or drive media (section 11.2) with `403 capability_disabled`.
- Turning `stream` off while streams are live ends them with `stream.ended { reason: room_closed }`
  (and `stream.stop` to the helpers), then `room.updated`.
- Since 1.10 voice has its messages (section 7.5): in a room without `voice` they are answered
  with `error { code: capability_disabled, capability: voice }`. Since 1.11 the same holds for
  text and the chat messages (section 7.6). Since 1.12 cameras have theirs (section 7.7):
  without `camera`, `voice.cameraOff` and the camera routes answer
  `capability_disabled { capability: camera }`.

### 7.5 Voice channel (since 1.10)

A room with the `voice` capability has one voice channel. Web connections only; a helper sending a
voice message gets `forbidden`. Voice does not use viewer slots: it has its own
limit, `RoomSettings.maxVoiceParticipants` (default 12).

**Roster.** Everyone in the room sees who is in voice: `welcome.voice` (absent in a room without
voice), then `voice.joined`, `voice.updated` and `voice.left` to every web connection. A user is
in voice from **one tab** at a time: `voice.join` from another tab of the same user moves the voice
there (the old tab gets `voice.left { reason: moved }`, its microphone and pulls are closed, and
everyone else gets `voice.updated`). Closing the voice tab is `voice.left { reason: disconnected }`.

**Permissions** (`can()`). `Permissions.canJoinVoice`: anyone who
may see the room, when it has voice. `Permissions.canSpeak`: the same, and for a guest only when
`RoomSettings.guestsCanSpeak` is not false (default true). Someone without `canSpeak` joins and
listens, always muted. `voice.serverMute` and `voice.kick` need `canModerate` (owner or admin) and
follow the rule of removing someone: the owner acts on anyone else, an admin only on members and
guests (`forbidden` otherwise, also on yourself). The room sends `permissions.changed` when the
room's settings change what a connection's voice permissions are.

**Messages.**

1. `voice.join { muted?, deafened? }` → `voice.joined { participant }` (to everyone else too).
   Errors: `capability_disabled`, `voice_full { limit }`. Joining again from the same tab is
   idempotent. Then the tab gets `voice.tracks`.
2. `voice.state { muted, deafened }` → `ack`, and `voice.updated` to everyone. Deafened implies
   muted (the room stores `muted: true` while deafened). `muted: false` without `canSpeak` is
   `voice_speak_not_allowed`. Deafen is local (the client stops playing voice); the room keeps
   the pulls.
3. `voice.leave` → `voice.left { reason: left }` (with the request `id` to the sender, and to
   everyone). Idempotent: when not in voice the reply is the same and nobody else hears it.
4. `voice.tracks { tracks[] }` goes only to the tab in voice: every published microphone of the
   others (`VoiceTrack { trackId, userId }`), the full list each time. It is sent after
   `voice.joined` and whenever a microphone appears or goes away. The client pulls new `trackId`s
   with `POST .../voice/subscribe` and stops the transceivers of the ones that disappeared: the
   room has already closed those pulls (`tracks/close`, `force`).
5. `voice.serverMute { userId, muted }` → `ack`. The target's `serverMuted` changes
   (`voice.updated` to everyone). **Server mute closes the target's microphone track** at the SFU
   (so nobody receives it, whatever the client does), drops it from everyone's `voice.tracks` and
   refuses `voice/publish` with `403 voice_speak_not_allowed` until it is lifted (it lasts across
   leaving and joining again, while the room is open); then the client
   publishes again. Errors: `forbidden`, `voice_not_joined { userId }`.
6. `voice.kick { userId }` → `ack`. The target leaves (`voice.left { reason: kicked }` to
   everyone), and their microphone and pulls are closed. They may join again; to keep them out,
   remove them from the room.

**Other ends.** Removal, ban or lost access takes the user out of voice
(`voice.left { reason: removed }`) before `kicked` / `forbidden` and the close. Turning the room's
`voice` capability off takes everyone out (`voice.left { reason: capability_disabled }`, then
`room.updated`). A room closing closes everything with `room.closed`.

**Quota.** Voice keeps working when the quota blocks new streams (brake 4) and in economy mode: a
microphone costs about 32 kbps per listener. It is still
metered: every pulled voice track accrues 32 kbps into `usage_daily` with the same formula as
streams.

The speaking indicator is computed locally from the audio level; it never goes through the server.

### 7.6 Text chat (since 1.11)

A room with the `text` capability has one text chat. Its messages live in the `RoomDO`'s SQLite
and travel on the room socket. Web connections only: a helper sending a chat message gets
`forbidden`, and a room without `text` answers `error { code: capability_disabled, capability:
text }`.

**Messages are plain text.** `ChatMessage { id, userId?, authorName, text, createdAt, editedAt?,
mentions[] }`. Clients never render `text` as HTML; they may turn `http(s)://` URLs into links
(opened with `rel="noopener noreferrer"`) and highlight mentions. The room trims the text, drops
control characters other than newline and tab, and refuses more than **2,000 characters** (code
points) with `chat_message_too_long { limit: 2000 }`. `userId` is absent when the platform admin
deleted the author's account and kept its messages anonymized (the client shows "account
removed").

**Permissions** (`can()`). `Permissions.canReadChat`: anyone who
may see the room, when it has text. `Permissions.canWriteChat`: the same, and for a guest only when
`RoomSettings.guestsCanWrite` is not false (default true). Deleting someone else's message needs
`canModerate` and follows the rule of removing someone: the owner deletes anyone else's, an admin
only members', guests' and removed accounts' (`forbidden` otherwise). Removal, ban or lost access
closes the socket (section 7.1), which is also the end of the person's chat access.

**Messages.**

1. `chat.send { text, clientId }` → `chat.message { message, clientId }` to the sender (with the
   request `id`) and `chat.message { message }` to every other web connection. Errors:
   `capability_disabled`, `chat_write_not_allowed`, `chat_message_too_long`, `rate_limited {
retryAfterMs }` (at most 30 sends and edits per person per minute), `invalid_message` (empty
   after trimming).
2. `chat.edit { messageId, text }` → `chat.edited { messageId, text, editedAt, mentions }` (to
   everyone; the sender's copy has the `id`). Only your own message. Errors as for `chat.send`,
   plus `chat_message_not_found`, `forbidden` (someone else's).
3. `chat.delete { messageId }` → `chat.deleted { messageId }` (to everyone). The room clears the
   text at once and keeps no copy. Errors: `chat_message_not_found`, `forbidden`.
4. `chat.history { before?, limit? }` → `chat.page { messages, hasMore }`, oldest first: the
   newest `limit` (default 50, at most 100) messages older than `before` (a message id), or the
   newest of all. Deleted messages are left out.
5. `chat.read { messageId }` → `ack`. The room keeps the newest message each user read (from any
   tab); it never moves back.

**Unread.** `welcome.chat { unread, lastReadId? }` (web, rooms with text): messages by others after
the user's `chat.read`, capped at 100. The space's room list gets the same counts from `GET
/api/spaces/:spaceId/chat/unread` → `{ rooms: { [roomId]: number } }` (rooms with text the caller
may see; rooms without unread messages are left out).

**Mentions.** The room resolves `@name` server-side against the display names of the people who
are, or were, connected to the room and still may see it, longest name first, case-insensitive,
and lists them in `mentions[]` (never the author). Each mentioned user's web tabs get the hub
notice `notice { event: chat_mention, roomId, userId }` (`userId` is the author), wherever they
are in the app.

**Retention** (`RoomSettings.chatRetentionDays`): 0 (no history: every message is deleted when the
last connection leaves the room), 7, 30 (default) or 90 days, chosen by the room within the
space's ceiling (platform: 90). The DO alarm deletes expired messages; no message is sent for it.
A quick room's chat ends with the room, and archiving or deleting a fixed room deletes its chat.
Turning `text` off keeps the messages under the same retention.

**Account deletion** (`DELETE /api/admin/users/:userId { ban?, messages? }`): `messages: "delete"` (default) deletes every message of the account
in every room (`chat.deleted` to whoever is connected); `"anonymize"` keeps them without `userId`
and with an empty `authorName`. Either way the account leaves every `mentions[]`.

### 7.7 Cameras in the voice channel (since 1.12)

A room with the `camera` capability (which needs `voice`) lets the people in voice turn a camera
on. Off by default; only someone in voice (from the tab that is in voice) has one. Cameras cost
egress (every camera is pulled by everyone else in voice), so they have their own limit,
`RoomSettings.maxCameras` (default 6, platform → space → room, each level only lowers it).

**Permissions** (`can()`). `Permissions.canUseCamera`: the room
has `camera`, and for a guest only when `RoomSettings.guestsCanUseCamera` is true (default false).
`voice.cameraOff` needs `canModerate` under the rule of removing someone, like `voice.serverMute`.

**On and off.** The camera is a sendonly video on the viewer session, published with
`POST .../camera/publish` (section 11.2), simulcast in at most two layers, highest first: `h`
(640×360 at 30 fps, ~500 kbps) and `l` (320×180, ~150 kbps). The room checks, in order: the camera
capability (`403 capability_disabled { capability: camera }`), the session, in voice
(`409 voice_not_joined`), `canUseCamera` (`403 camera_not_allowed`), the quota brake
(`403 quota_exhausted`: no new camera once the quota blocks new streams; voice continues), the
limit (`409 camera_limit_reached { limit }`), and that `mid` is a video m-section with at most two
`a=rid` layers (`400 invalid_message`, `path: /mid`). Publishing again replaces your camera. The
camera on, everyone gets `voice.updated` with `participant.camera: true`, and everyone else in
voice gets `voice.tracks` with the camera in `cameras` (`CameraTrack { trackId, userId, rids }`).
`POST .../camera/unpublish` turns it off (`camera: false`). Mute, deafen and server mute do not
touch the camera.

**The room turns a camera off** (closes it at the SFU, `camera: false` to everyone, and
`voice.cameraStopped { reason }` to the owner's tab, which stops its transceiver and track):

- `voice.cameraOff { userId }` → `ack` (reason `moderator`). Errors: `forbidden`,
  `voice_not_joined { userId }`. Already off: `ack`. The person may turn it on again.
- The room's `camera` (or `voice`) capability turned off (`capability_disabled`).
- The person may no longer use a camera: a new role, or `guestsCanUseCamera` turned off
  (`not_allowed`; `permissions.changed` carries the new `canUseCamera`).
- `maxCameras` lowered below the cameras on: the newest ones beyond the limit (`limit`).
- The quota brake: when the grace period after the quota blocks new streams ends, live streams end
  and every camera is turned off (`quota_exhausted`); the voice keeps going.

Leaving voice (any reason, including moving to another tab) closes the camera with the microphone;
the new tab publishes again.

**Pulling.** Everyone in voice pulls the others' cameras with `POST .../camera/subscribe` (1–4 per
request, like voice), on the low layer for the strip (the default), and switches one camera to the
high layer with `PUT .../camera/layer` while it is enlarged (`tracks/update` on the same mid, no
renegotiation; back to `l` when it is closed). A camera's audio is its owner's microphone: the
client puts both in one msid stream before `setRemoteDescription`, so lip sync holds.
On a bad network the client lowers or pauses the cameras before the voice.

**Meter.** Every pulled camera accrues the bitrate of the layer it is on (500 kbps for `h`, 150 kbps
for `l`, 500 kbps for a camera without layers) into `usage_daily` with the same formula as streams,
and every camera pull adds one join at 500 kbps (the SFU starts every pull on the top layer, ADR
0039).

### 7.8 Room presence in the space sidebar (since 1.13)

The sidebar lists the rooms of the open space and, under each, who is in its voice channel and who
streams there, like Discord's channel list. Only the room's own socket knows its presence, so each
`RoomDO` pushes a compact summary to the `SpaceDO` of its space (one per space,
`idFromName(spaceId)`), and web tabs subscribe to that one DO instead of opening a socket per room.

**Summary.** `RoomPresence { roomId, voice[], live[] }`:

- `voice[]`: `VoicePresence { userId, displayName, avatarUrl?, muted, deafened, camera? }`, one per
  person in the room's voice channel, oldest first. `muted` is true when the person muted
  themselves, is deafened, cannot speak, or is server-muted.
- `live[]`: `LivePresence { userId, displayName?, avatarUrl?, streamId, paused? }`, one per stream
  in the room, oldest first. `displayName` is absent only while the streamer has no socket in the
  room (the helper's grace period, section 7.2).

A room with nobody in voice and no stream has an empty summary; the `SpaceDO` forgets it. Display
names come from the room's connections, which read them from D1 at the upgrade, so they need no
lookup of their own.

**Delivery.** The `RoomDO` compares its summary with the last one it pushed at the end of every
event (a message, a close, an RPC, its alarm) and pushes when it changed: at once when the previous
push is at least 1 s old, otherwise at the end of that second (its alarm), so a burst of changes
costs one push. A room with a non-empty summary pushes it again every 10 minutes, and the
`SpaceDO` drops a summary not refreshed for 25 minutes (a room whose DO stopped without a close
event, e.g. during a deploy, does not show people forever). A failed push is retried 5 s later.

**Subscribing.** `GET /ws/spaces/:spaceId` with the session cookie (web only: a device token is
refused with `403 forbidden`). The Worker checks `can(actor, 'space.view')` (`403 forbidden`, or
`404 space_not_found` for a deleted space; a suspended space is `403 space_suspended`) and computes
which restricted rooms the caller can see (`room.view`: managers all, others those with an active
`room_access` grant). Then the usual `hello` (`client: "web"`, a `tabId`), answered by
`space.presence { spaceId, protocol, minProtocol, serverTime, rooms[] }`: every non-empty summary the
caller may see. After that, `space.presence.updated { room }` whenever one of those rooms' summary
changes (an empty `voice` and `live` means the room is quiet now).

**Access.** A summary goes only to connections that can view the room: rooms with visibility
`space` to everyone in the space, restricted rooms to managers and to holders of an active grant,
as `can()` decides. When the Worker changes someone's role or room access (the same path that
updates their room sockets), the `SpaceDO` reloads that person's access and
sends a fresh `space.presence` (as an event, without `id`) to their sockets; someone who can no
longer view the space gets `error forbidden`, then close **4003**. A room that becomes restricted
hides its summary at once.

The client subscribes only while a space's sidebar is shown, closes the socket when it is not, and
reconnects with backoff after an abnormal close. Room sockets and the hub are unchanged.

### 7.9 Visual pointer pings (since 1.20)

A viewer taps or clicks the video and the streamer sees a pulsing marker with the viewer's name at
that point, drawn by the helper on the shared screen. Nothing is injected into the streamer's
computer.

1. **Allowing.** `pings` in `StreamInfo` (absent = false) says viewers may ping. It is off by
   default. The streamer turns it on or off with `stream.setPings { streamId, enabled }` (reply
   `ack`), only on their own stream (`forbidden` otherwise, `stream_not_found` for an unknown or
   ended one). Everyone gets `stream.updated` with the full `StreamInfo`. Enabling needs
   `pingOverlay` (below): without it the room answers `forbidden`. Ending the stream drops the flag
   with the stream.
2. **`pingOverlay`.** The helper says in `stream.announce` that it can draw pings (absent =
   false); the room copies it to `StreamInfo.pingOverlay`. Clients only offer the toggle and the
   click mode when it is true. A helper before 1.20 never announces it, so pings can never be
   enabled on its streams and it never receives `pointer.pinged`.
3. **Pinging.** `pointer.ping { streamId, x, y, style }` (web to room, no reply on success).
   `x` and `y` are numbers from 0 to 1 over the video frame (0,0 is the top left); anything outside
   is `invalid_message`. `style` is `{ color, shape }` from closed lists: `color` is one of `olive`,
   `red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `pink`, `white`; `shape` is one of
   `ring`, `dot`, `crosshair`, `star`. Errors come back as `error` with the request `id`:
   `stream_not_found`, `forbidden` (the sender holds no viewer slot on that stream, or it is their
   own stream), `pings_disabled`, `rate_limited` with `retryAfterMs`.
4. **Rules.** Only a viewer holding a slot on that stream may ping (section 7.3), never on their
   own stream. A ping is dropped silently (no error) while the stream is paused, including the
   privacy curtain (`paused` is true).
5. **Rate limit.** Per user: 4 pings per second, with a burst of 8 (a token bucket); beyond it,
   `rate_limited { retryAfterMs }`.
6. **Forwarding.** The room sends `pointer.pinged { streamId, userId, name, x, y, style }` only to
   the room socket of the stream's publishing helper, never to web clients or other helpers. `name`
   is the sender's display name. The helper draws the marker for about 2 seconds. The viewer's own
   web client draws their click at once, locally.

## 8. User hub (`UserHubDO`)

One hub per user; its connections are that user's web tabs and paired helpers. Nobody else can
connect to it, which is what keeps source thumbnails private.

### 8.1 Helper presence

- `hub.welcome` lists the helpers online now. Then `helper.online { helper }` and
  `helper.offline { deviceId }` keep web tabs up to date ("Helper connected: Henrique's PC").
- A helper sends `helper.status` after `hub.welcome` and on every state change; the hub relays it
  to all the user's web tabs.

### 8.2 Commands (web → helper)

Commands carry the target `deviceId`. The hub checks the device belongs to the user and is online
(`helper_offline` otherwise), forwards the message to that helper with a new hub-chosen `id`, and
relays the helper's reply back to the tab that asked, with the tab's original `id`. Pending
commands fail with `helper_offline` if the helper disconnects first.

| Command                                                                  | Reply            | Effect                                                                                                           |
| ------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `helper.listSources { thumbnails }`                                      | `helper.sources` | Screens and windows. With `thumbnails: true` the helper follows up with one `helper.sourceThumbnail` per source. |
| `helper.startStream { roomId, sourceId, preset, audio, audioSourceId? }` | `ack`            | Starts publishing and announcing in the room; progress via `helper.status`. `helper_busy` if already live.       |
| `helper.stopStream`                                                      | `ack`            | Stops the current stream (also from another device).                                                             |
| `helper.pauseStream { paused }`                                          | `ack`            | Privacy curtain on/off.                                                                                          |
| `helper.setPreset { preset }`                                            | `ack`            | Changes the preset of the current stream.                                                                        |
| `helper.setVoiceOutput { label? }` (since 1.16)                          | `ack`            | The speakers the voice sink plays on, by the browser's label; no label: the default output (section 8.4).        |

**Wayland sources.** The portal shows its own picker, so a Wayland helper lists `portal:screen` and
`portal:window`, which always open the system dialog, and, once something was shared, the last
screen and window (`portal:screen:last`, `portal:window:last`, with the chosen output or window as
`label` and `restored: true`, since 1.3), which the portal shares again without the dialog. The
helper checks that a restored source is the one chosen before and shows the dialog when it is not.

**Thumbnails of the source picker** (`helper.sourceThumbnail`) go only to the web tab that sent
`helper.listSources` — never to other users, never to a room — and are not stored anywhere (no R2,
no DO storage). Stream thumbnails shown on room cards are a different thing: they are uploaded by
REST (`PUT /api/streams/:id/thumbnail`) and served with a permission check.

### 8.3 Helper reports and notices

- `helper.stats` about once a second while live, for the streamer's "stats for nerds". Since 1.7
  it also carries `capturedFps`, `cpuPct` (the helper process, percent of one core),
  `keyframeRequests` (PLIs and FIRs since the previous report) and `idrBytes` (the largest
  keyframe since the previous report). The hub aggregates these into one Analytics Engine data
  point per stream every 30 s (docs/observability.md); nothing else is stored.
- `notice { event, roomId?, streamId?, userId? }` carries user notices that the web turns into a
  sound and a toast.

### 8.4 Voice sink (since 1.16)

Sharing a browser window with its audio captures every playback stream of that browser, so the
voice of the people in an Openlive voice channel played by the same browser would reach the stream
and they would hear themselves.

- While it runs, a Linux helper keeps a virtual speaker, "Openlive – voice", and reports it in
  `helper.status.voiceSink` (`name` is the PipeWire node, `label` the description browsers list).
  It plays on the default output, or on the one `helper.setVoiceOutput` names (matched against the
  sinks' descriptions; a label it does not know falls back to the default).
- App-audio capture never takes a playback stream that plays into the voice sink.
- The web plays voice, and the notice sounds, into the output whose label is `voiceSink.label`
  (`setSinkId`), and sends `helper.setVoiceOutput` with the output picked in Settings > Voice.
- `HelperStreamStatus.audioApp` says whose audio a stream captures; `browser` is set when it is a
  web browser. When it is the browser the web plays voice in and voice is not routed to the voice
  sink, the web warns the streamer.

### 8.5 Global voice shortcuts (since 1.21)

In the browser, push-to-talk, mute and deafen only work while the Openlive tab has focus. A helper
that binds global shortcuts for them (a game can have the focus) reports each press as
`helper.voiceShortcut { deviceId, action, pressed }`, with `action` one of `pushToTalk`,
`toggleMute` and `toggleDeafen`.

- Push-to-talk reports both edges (`pressed: true`, then `false`); the toggles report the press
  only (`pressed: true`).
- The hub relays it to all the user's web tabs, with the helper's own `deviceId`, like
  `helper.status`. It stores nothing and sends no reply.
- Only one tab acts: the one that is in voice, and when several are, the one that joined voice
  most recently. It applies the action as the in-page controls do (push-to-talk only when the
  person turned it on). A tab not in voice ignores it.
- A helper announces the capability with its protocol: 1.21 or later. A helper before 1.21 never
  sends the message.

## 9. Message catalogue

Phase is the development phase that first needs the message. Direction: C→S client to the DO,
S→C DO to client, W→H web to helper relayed by the hub, H→W helper to web relayed by the hub.

### 9.1 Both endpoints

| Type    | Phase | Direction         | Payload                                                                                  | Reply                                                     |
| ------- | ----- | ----------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `hello` | 1     | C→S (web, helper) | `protocol`, `client`, `clientVersion`, `deviceId`? (required for helper), `tabId`? (web) | `welcome` / `hub.welcome` / `space.presence` (since 1.13) |
| `ping`  | 1     | C→S               | `{}` — exact bytes, see section 4                                                        | `pong`                                                    |
| `pong`  | 1     | S→C               | `{}`                                                                                     |                                                           |
| `error` | 1     | S→C               | `ErrorPayload` (section 6)                                                               |                                                           |
| `ack`   | 1     | S→C               | `{}`                                                                                     |                                                           |

### 9.2 Room

| Type                    | Phase | Direction                    | Payload                                                                                                                                     | Reply                                       |
| ----------------------- | ----- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `welcome`               | 1     | S→C                          | `protocol`, `minProtocol`, `serverTime`, `you`, `room`, `settings`, `members[]`, `streams[]`, `voice[]`? (since 1.10), `chat`? (since 1.11) |                                             |
| `member.joined`         | 1     | S→C                          | `member`                                                                                                                                    |                                             |
| `member.updated`        | 1     | S→C                          | `member`                                                                                                                                    |                                             |
| `member.left`           | 1     | S→C                          | `userId`                                                                                                                                    |                                             |
| `permissions.changed`   | 1     | S→C                          | `you`                                                                                                                                       |                                             |
| `kicked`                | 1     | S→C                          | `reason`; then close 4004                                                                                                                   |                                             |
| `room.expiring`         | 1     | S→C                          | `expiresAt`                                                                                                                                 |                                             |
| `room.closed`           | 1     | S→C                          | `reason`; then close 4005                                                                                                                   |                                             |
| `room.updated`          | 1     | S→C                          | `settings` (since 1.9)                                                                                                                      |                                             |
| `viewers`               | 1     | S→C                          | `streamId`, `viewerUserIds[]`, `used`, `limit`, `queueLength`                                                                               |                                             |
| `slot.request`          | 1     | C→S (web)                    | `streamId`                                                                                                                                  | `slot.granted` / `error`                    |
| `slot.granted`          | 1     | S→C (web)                    | `slotId`, `streamId`, `expiresAt`, `leaseMs`                                                                                                |                                             |
| `slot.renew`            | 1     | C→S (web)                    | `slotId`                                                                                                                                    | `slot.renewed` / `error`                    |
| `slot.renewed`          | 1     | S→C (web)                    | `slotId`, `expiresAt`                                                                                                                       |                                             |
| `slot.release`          | 1     | C→S (web)                    | `slotId`                                                                                                                                    | `slot.released`                             |
| `slot.released`         | 1     | S→C (web)                    | `slotId`, `streamId`, `reason`                                                                                                              |                                             |
| `queue.join`            | 1     | C→S (web)                    | `streamId`                                                                                                                                  | `queue.position` / `slot.granted` / `error` |
| `queue.position`        | 1     | S→C (web)                    | `streamId`, `position`, `length`                                                                                                            |                                             |
| `queue.offer`           | 1     | S→C (web)                    | `streamId`, `offerId`, `expiresAt`                                                                                                          |                                             |
| `queue.accept`          | 1     | C→S (web)                    | `offerId`                                                                                                                                   | `slot.granted` / `error`                    |
| `queue.leave`           | 1     | C→S (web)                    | `streamId`                                                                                                                                  | `ack`                                       |
| `queue.left`            | 1     | S→C (web)                    | `streamId`, `reason`                                                                                                                        |                                             |
| `stream.announce`       | 2     | C→S (helper; web since 1.22) | `sfuSessionId`, `source`, `preset`, `tracks[]` (1–4), `hasAudio`, `viewerLimit`?, `layers`? (1.19), `pingOverlay`? (1.20)                   | `stream.started` / `error`                  |
| `stream.started`        | 2     | S→C                          | `stream`                                                                                                                                    |                                             |
| `stream.update`         | 2     | C→S (helper; web since 1.22) | `streamId`, `paused`?, `pauseReason`?, `preset`?, `layers`? (1.19)                                                                          | `ack` / `error`                             |
| `stream.updated`        | 2     | S→C                          | `stream`                                                                                                                                    |                                             |
| `stream.end`            | 2     | C→S (helper; web since 1.22) | `streamId`                                                                                                                                  | `ack`                                       |
| `stream.ended`          | 2     | S→C                          | `streamId`, `reason`                                                                                                                        |                                             |
| `stream.setViewerLimit` | 2     | C→S (web, helper)            | `streamId`, `limit`                                                                                                                         | `ack` / `error`                             |
| `stream.terminate`      | 2     | C→S (web)                    | `streamId`                                                                                                                                  | `ack` / `error`                             |
| `stream.stop`           | 2     | S→C (helper; web since 1.22) | `streamId`, `reason`                                                                                                                        |                                             |
| `stream.setPings`       | 2     | C→S (web)                    | `streamId`, `enabled` (since 1.20)                                                                                                          | `ack` / `error`                             |
| `pointer.ping`          | 2     | C→S (web)                    | `streamId`, `x`, `y`, `style` (since 1.20)                                                                                                  | `error` (none on success)                   |
| `pointer.pinged`        | 2     | S→C (helper)                 | `streamId`, `userId`, `name`, `x`, `y`, `style` (since 1.20)                                                                                | —                                           |
| `voice.join`            | 6     | C→S (web)                    | `muted`?, `deafened`? (since 1.10)                                                                                                          | `voice.joined` / `error`                    |
| `voice.joined`          | 6     | S→C (web)                    | `participant`                                                                                                                               |                                             |
| `voice.leave`           | 6     | C→S (web)                    | `{}`                                                                                                                                        | `voice.left` / `error`                      |
| `voice.left`            | 6     | S→C (web)                    | `userId`, `reason`                                                                                                                          |                                             |
| `voice.state`           | 6     | C→S (web)                    | `muted`, `deafened`                                                                                                                         | `ack` / `error`                             |
| `voice.updated`         | 6     | S→C (web)                    | `participant`                                                                                                                               |                                             |
| `voice.tracks`          | 6     | S→C (web in voice)           | `tracks[]` (`trackId`, `userId`), `cameras[]`? (`trackId`, `userId`, `rids`; since 1.12)                                                    |                                             |
| `voice.serverMute`      | 6     | C→S (web)                    | `userId`, `muted`                                                                                                                           | `ack` / `error`                             |
| `voice.kick`            | 6     | C→S (web)                    | `userId`                                                                                                                                    | `ack` / `error`                             |
| `voice.cameraOff`       | 6     | C→S (web)                    | `userId` (since 1.12)                                                                                                                       | `ack` / `error`                             |
| `voice.cameraStopped`   | 6     | S→C (web in voice)           | `reason` (since 1.12)                                                                                                                       |                                             |
| `chat.send`             | 6     | C→S (web)                    | `text`, `clientId` (since 1.11)                                                                                                             | `chat.message` / `error`                    |
| `chat.message`          | 6     | S→C (web)                    | `message`, `clientId`? (sender only)                                                                                                        |                                             |
| `chat.edit`             | 6     | C→S (web)                    | `messageId`, `text`                                                                                                                         | `chat.edited` / `error`                     |
| `chat.edited`           | 6     | S→C (web)                    | `messageId`, `text`, `editedAt`, `mentions[]`                                                                                               |                                             |
| `chat.delete`           | 6     | C→S (web)                    | `messageId`                                                                                                                                 | `chat.deleted` / `error`                    |
| `chat.deleted`          | 6     | S→C (web)                    | `messageId`                                                                                                                                 |                                             |
| `chat.history`          | 6     | C→S (web)                    | `before`?, `limit`?                                                                                                                         | `chat.page` / `error`                       |
| `chat.page`             | 6     | S→C (web)                    | `messages[]`, `hasMore`                                                                                                                     |                                             |
| `chat.read`             | 6     | C→S (web)                    | `messageId`                                                                                                                                 | `ack` / `error`                             |

Slots and the queue are part of the foundation (the first version): viewer slots and the priority
queue are exercised against test streams until real ones exist.

### 9.3 User hub

| Type                     | Phase | Direction                 | Payload                                                                                                                                                    | Reply                      |
| ------------------------ | ----- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `hub.welcome`            | 3     | S→C                       | `protocol`, `minProtocol`, `serverTime`, `userId`, `connectionId`, `helpers[]`                                                                             |                            |
| `helper.online`          | 3     | S→C (web)                 | `helper`                                                                                                                                                   |                            |
| `helper.offline`         | 3     | S→C (web)                 | `deviceId`                                                                                                                                                 |                            |
| `helper.listSources`     | 3     | W→H                       | `deviceId`, `thumbnails`                                                                                                                                   | `helper.sources` / `error` |
| `helper.sources`         | 3     | H→W                       | `deviceId`, `sources[]`                                                                                                                                    |                            |
| `helper.sourceThumbnail` | 3     | H→W (requesting tab only) | `deviceId`, `sourceId`, `mimeType`, `width`, `height`, `data` (base64)                                                                                     |                            |
| `helper.startStream`     | 3     | W→H                       | `deviceId`, `roomId`, `sourceId`, `preset`, `audio`, `audioSourceId`?                                                                                      | `ack` / `error`            |
| `helper.stopStream`      | 3     | W→H                       | `deviceId`                                                                                                                                                 | `ack` / `error`            |
| `helper.pauseStream`     | 3     | W→H                       | `deviceId`, `paused`                                                                                                                                       | `ack` / `error`            |
| `helper.setPreset`       | 3     | W→H                       | `deviceId`, `preset`                                                                                                                                       | `ack` / `error`            |
| `helper.setVoiceOutput`  | 3     | W→H                       | `deviceId`, `label`? (since 1.16)                                                                                                                          | `ack` / `error`            |
| `helper.status`          | 3     | H→W (all tabs)            | `deviceId`, `state`, `stream`?, `voiceSink`? (since 1.16)                                                                                                  |                            |
| `helper.stats`           | 3     | H→W (all tabs)            | `deviceId`, `streamId`, `targetBitrateKbps`, `sentBitrateKbps`, `fps`, `width`, `height`, `packetLossPct`, `rttMs`, `encoder`? and `layers[]`? (since 1.2) |                            |
| `helper.voiceShortcut`   | 3     | H→W (all tabs)            | `deviceId`, `action` (`VoiceShortcutAction`), `pressed` (since 1.21)                                                                                       |                            |
| `notice`                 | 5     | S→C (web)                 | `event`, `roomId`?, `streamId`?, `userId`?                                                                                                                 |                            |

### 9.4 Space (since 1.13)

| Type                     | Phase | Direction | Payload                                                                        | Reply |
| ------------------------ | ----- | --------- | ------------------------------------------------------------------------------ | ----- |
| `space.presence`         | 6     | S→C (web) | `spaceId`, `protocol`, `minProtocol`, `serverTime`, `rooms[]` (`RoomPresence`) |       |
| `space.presence.updated` | 6     | S→C (web) | `room` (`RoomPresence`)                                                        |       |

`hello` on a space connection is answered by `space.presence`.

### 9.5 Reserved for later

Not in version 1.0; names reserved so they are not reused for something else: `control.*` for
"request control" (future); `pointer.*` is used since 1.20 (section 7.9). Voice signalling arrived in 1.10 (section 7.5), the text chat (`chat.*`)
in 1.11 (section 7.6).

## 10. Shared types

Defined in `packages/protocol/schema/common.json`; field-level detail is in the schema.

| Type                                                   | Notes                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `Id`                                                   | Opaque string, `[A-Za-z0-9_-]{1,64}`. Never parsed by clients.            |
| `UnixMs`                                               | Integer milliseconds since the epoch, UTC.                                |
| `ProtocolVersion`                                      | `{ major ≥ 1, minor ≥ 0 }`                                                |
| `ClientKind`                                           | `web`, `helper`                                                           |
| `Role`                                                 | `owner`, `admin`, `member`, `guest`                                       |
| `RoomKind`                                             | `fixed`, `quick`                                                          |
| `RoomVisibility`                                       | `space`, `restricted`                                                     |
| `Preset`                                               | `text`, `game`, `max`, `native`, `game120`, `max120` (since 1.8)          |
| `SourceKind`                                           | `screen`, `window` (region is a later, additive value)                    |
| `PauseReason`                                          | `source_hidden`, `privacy_curtain`, `user`                                |
| `HelperState`                                          | `idle`, `starting`, `live`, `paused`, `stopping`, `error`                 |
| `Member`, `You`, `Permissions`                         | Presence and the connection's own permissions.                            |
| `RoomInfo`, `RoomSettings`                             | Room identity and effective limits.                                       |
| `Capability`, `RoomCapabilities`                       | `stream`, `voice`, `camera`, `text` (since 1.9, section 7.4)              |
| `VoiceParticipant`, `VoiceTrack`                       | The voice roster and the microphones to pull (since 1.10, 7.5).           |
| `CameraTrack`                                          | A camera to pull, with its simulcast layers (since 1.12, 7.7).            |
| `ChatMessage`, `ChatSummary`, `ChatRetentionDays`      | The text chat (since 1.11, 7.6).                                          |
| `RoomPresence`, `VoicePresence`, `LivePresence`        | A room's voice and streams in the space sidebar (since 1.13, 7.8).        |
| `StreamInfo`, `SourceInfo`, `Track`                    | A live stream as the room shows it; tracks only in `stream.announce`.     |
| `StreamOrigin`                                         | `helper` or `browser`: who publishes a stream (since 1.22, 7.2).          |
| `VideoCodec`                                           | `h264` or `av1`: a video track's codec, what a viewer pulls (since 1.14). |
| `VideoLayer`, `VideoLayers`                            | A stream's simulcast layers as encoded (since 1.19, 7.2).                 |
| `PointerStyle`, `PointerColor`, `PointerShape`         | Look of a pointer ping (since 1.20, 7.9).                                 |
| `VoiceShortcutAction`                                  | `pushToTalk`, `toggleMute`, `toggleDeafen` (since 1.21, 8.5).             |
| `HelperInfo`, `SourceDescriptor`, `HelperStreamStatus` | Hub-side helper data.                                                     |
| `HelperAudioApp`, `BrowserFamily`, `VoiceSink`         | Whose audio a stream captures; the voice sink (since 1.16, 8.4).          |

## 11. REST bodies

Every REST error uses `ErrorPayload` (section 6). Request and response bodies of the REST routes
are added to the schema as the routes are implemented, starting with the first version, under
the same additive rules.

The first version implements the space, member, room, room access, invite and join request routes in
`apps/api/src/api/` (bodies validated with Zod there; their JSON Schemas come with the web client
that consumes them). Conventions:

- JSON in and out, camelCase fields, timestamps in `UnixMs`. A refused body is `400
invalid_message` with `path` pointing at the first offending field (`/settings/maxStreams`).
- Every decision goes through `can()`. Someone outside a space gets `404 space_not_found` from the
  space routes, so space ids cannot be probed; inside a room the answer matches the room socket
  (`403 forbidden { roomId }`, `410 room_closed`).
- Settings PATCHes set the keys sent and remove the keys sent as `null`; a limit above the level
  above it is refused with `setting_above_ceiling`, never clamped.
- Invite tokens appear only in the response that creates them.
- A change of role, ban, removal or room grant reaches open sockets at once through the RoomDO
  (`permissions.changed`, `kicked` + 4004, or `error forbidden` + 4003, section 7).
- The platform admin routes (`/api/admin/*`: overview, settings, space suspension) answer
  `403 forbidden` to everyone else. Suspending a space closes its rooms with the reason
  `suspended`, and every later space or room request gets `403 space_suspended`.
- Quick rooms have a join code (`OL-4821-0937`: eight digits, unique among the rooms not archived,
  across spaces). `POST /api/rooms/join { code }` accepts it in any case, with or without `OL`,
  spaces or hyphens. Members of the room's space enter with their own role; anyone else signed in
  gets a `room_access` grant that ends when the room expires. Attempts are
  limited per user and per IP (`429 rate_limited`); a closed room answers `410 room_closed`.
- Sign-up policy (platform setting `signup`: `invite_only`, the default, or `open`). An existing
  account always signs in. A login that would create an account needs, in `invite_only` mode, a
  valid invite token or quick room code: `GET /api/auth/discord/start?invite=<token>` or
  `?code=<OL-…>` (kept in the signed state cookie), and `invite` / `code` in the
  `POST /api/auth/email/start` body (kept with the e-mail token). It is checked when the account
  would be created (not revoked, expired or used up, room open, space not suspended) and never
  takes a use of the invite. Without one, Discord redirects with `?authError=signup_invite_required`
  (or the invite's own code, `invite_expired` and so on), and the e-mail start answers the same
  `202 { sent: true }` as always but sends nothing to an address without an account. While the
  instance has no platform admin and an install code is set, sign-up is open so the owner can
  claim it. `GET /api/auth/policy` answers `{ signup }`, the policy in effect, without a session.
- Space creation policy (platform setting `spaceCreation`: `admin_only`, the default, or
  `members`). `POST /api/spaces` answers `403 space_creation_restricted` to anyone else;
  `GET /api/me` carries `canCreateSpace`.
- Platform user management (since 1.5), every route `403 forbidden` to
  anyone but the platform admin and audited (`platform.user.*`):
  - `GET /api/admin/users?query=&filter=all|no_space|banned|admins&cursor=`: live accounts,
    newest first, 50 a page (`nextCursor`, or null). Each has `id`, `displayName`, `avatarUrl`,
    `primaryEmail`, `providers`, `isPlatformAdmin`, `createdAt`, `lastSeenAt`, `bannedAt`,
    `deviceCount` and `spaces[]` (`id`, `name`, `slug`, `role`, `bannedAt` of a space-level ban).
    `query` matches the name or e-mail (anywhere, any case) or the exact id; `no_space` is an
    account in no live space, room grant or pending request.
  - `GET /api/admin/users/:userId`: the same plus `bannedReason`, `bannedBy`, `sessions[]`
    (`id`, `createdAt`, `lastSeenAt` (last renewal), `expiresAt`, `userAgent`; never an IP or
    its hash), `devices[]` (`Device`), `audit[]` (the last 50 entries by or about the account) and
    `streams[]` (live streams as metadata: `streamId`, `preset`, `sourceKind`, `startedAt`,
    `viewerCount`, and the room and space; never the source's label or any content).
  - `POST /api/admin/users/:userId/ban { reason? }`: sets the ban, revokes every session and
    device, records the account's identities as banned (hashes only), then closes its sockets:
    room sockets get `kicked { reason: banned }` and **4004** (streams end with
    `permission_revoked`, slots and queue places are released), hub sockets get
    `error session_expired` and **4001**. A banned account cannot sign in (Discord redirects with
    `?authError=account_banned`, the e-mail start answers `202` and sends nothing, a link sent
    before the ban is refused with `account_banned`), and no new account can sign up with its
    Discord account or e-mail address, also after it is deleted. Idempotent.
  - `POST /api/admin/users/:userId/unban`: lifts it and frees its identities; revoked sessions
    and devices stay revoked.
  - `POST /api/admin/users/:userId/sessions/revoke` and `.../devices/revoke`, without a ban:
    `{ revoked: n }`. Devices close as in section 11.1 (4001, streams end).
  - `DELETE /api/admin/users/:userId { ban? }`: deletes the account and its personal data, then
    closes its sockets (`kicked { reason: removed }`, 4004; hub 4001). `409 owner_must_transfer
{ spaceIds }` while it owns a live space. With `ban: true` its identities stay banned; a ban
    recorded before is never lifted by deleting.
  - Ban and delete answer `409 cannot_target_self` for the caller's own account and
    `409 last_platform_admin` when no other platform admin would be left.
- `GET /api/me` carries the instance's quota state as codes only (`quota.level`: `ok`, `warn_70`,
  `warn_90`, `warn_100`), so every user sees the warnings; the numbers are in the admin overview.

### 11.1 Device pairing (RFC 8628 style)

Since 1.1. Bodies are in `packages/protocol/schema/rest.json` (TypeScript and Go types are
generated from it). Shared pieces: `Device` (one entry of `DeviceList`),
`SessionDescription` (an SDP offer or answer), `IceServer`, `PublishTrack` / `PublishedTrack`
(publish request and response) and `SubscribedTrack`. The helper never sees a cookie; the web never sees a device token.

| Route                              | Caller                 | Request                | Response (success)            |
| ---------------------------------- | ---------------------- | ---------------------- | ----------------------------- |
| `POST /api/devices/code`           | helper, no credentials | `DeviceCodeRequest`    | `200` `DeviceCodeResponse`    |
| `POST /api/devices/token`          | helper, no credentials | `DeviceTokenRequest`   | `200` `DeviceTokenResponse`   |
| `GET /api/devices/code/:userCode`  | signed-in web user     | —                      | `200` `DeviceCodeInfo`        |
| `POST /api/devices/approve`        | signed-in web user     | `DeviceApproveRequest` | `200` `DeviceApproveResponse` |
| `GET /api/me/devices`              | signed-in web user     | —                      | `200` `DeviceList`            |
| `DELETE /api/me/devices/:deviceId` | signed-in web user     | —                      | `204`                         |

1. The helper (without a token) asks `POST /api/devices/code` with what it knows about itself. It
   gets a secret `deviceCode` (43 characters) and a `userCode` (`K7F-2QM`: six characters from
   `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, so no `0/O`, `1/I/L`), valid for 10 minutes, plus
   `verificationUriComplete` (`<instance>/link?code=K7F-2QM`), which it opens in the browser.
   Codes are limited per IP (`429 rate_limited`).
2. The person, signed in, sees the `/link` page: `GET /api/devices/code/:userCode` shows what the
   helper sent, and `POST /api/devices/approve` confirms it with a device name. User codes are
   accepted in any case, with or without the hyphen. Lookups and approvals are limited per user
   (`429 rate_limited`), so codes cannot be guessed. An unknown, expired or already approved
   code is `404 device_code_invalid`.
3. Meanwhile the helper polls `POST /api/devices/token` every `intervalMs` (5 s):
   `400 authorization_pending` until approved; `400 slow_down { intervalMs }` when it polls too
   early (the interval grows by 5 s each time); `400 expired_token` when the code expired or was
   already exchanged. After approval, the first poll creates the device and returns its token
   **once**; the server keeps only its SHA-256 (`devices.token_hash`).
4. The helper sends `Authorization: Bearer <deviceToken>` on every REST call and on the room and
   hub sockets. The Worker resolves it to `{ userId, deviceId }` and refreshes the device's
   `lastSeenAt` (at most every 5 minutes). A revoked token, or one of a deleted user, is
   `401 unauthenticated`; the helper then pairs again.
5. `DELETE /api/me/devices/:deviceId` revokes a device: its open room sockets get
   `error session_expired` and close with **4001**, and its live streams end
   (`helper_disconnected`). Someone else's device id is `404 device_not_found`.

### 11.2 SFU proxy

Since 1.1. The Worker is the only client of the Realtime API; the app token and the TURN key
token never leave it. Every SFU call for a room is made by that room's `RoomDO`, which owns the
room's SFU sessions: calls on one SFU session are **serialized** (one at a time, in order) and
spaced to stay under the SFU's **50 requests per second per session**, and each answer is checked
at all three levels (HTTP status, top-level `errorCode`, per-track `errorCode`) before anything is
stored. Any SFU refusal is `502 sfu_error`; the SFU's own text is logged by code only and never
returned.

Each route first authenticates (session cookie or device token), then loads the room and asks
`can(actor, 'room.view')` exactly like the room socket (`403 forbidden`, `404 room_not_found`,
`410 room_closed`, `403 space_suspended`). `503 rtc_not_configured` when the Realtime app or TURN
key is missing. Since 1.9, the routes that open or drive media (`publish`,
`publish/renegotiate`, `session`, `subscribe`, `renegotiate`, `layer` and the thumbnail upload)
also need the room's stream capability (`403 capability_disabled`, section 7.4); `ice`,
`unpublish`, `unsubscribe` and `leave` do not, so clients can always clean up. Since 1.10 the
viewer `session` and `renegotiate` need stream **or** voice (a voice-only room still opens its
session), `voice/publish` and `voice/subscribe` need voice (`403 capability_disabled { capability:
voice }`), and `voice/unpublish` and `voice/unsubscribe` need nothing. Since 1.12
`camera/publish`, `camera/subscribe` and `camera/layer` need the camera capability (`403
capability_disabled { capability: camera }`), and `camera/unpublish` and `camera/unsubscribe`
need nothing.

| Route                                                    | Caller | Extra checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Request                     | Response                        |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------- |
| `POST /api/rtc/rooms/:roomId/ice`                        | any    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                           | `200` `IceServersResponse`      |
| `POST /api/rtc/rooms/:roomId/publish`                    | helper | device token (`403 forbidden` otherwise); `can(stream.publish)` (`403 stream_permission_required`); quota brake (`403 quota_exhausted`); preset (`403 preset_not_allowed`); `maxBitrateKbps` (`403 bitrate_not_allowed`); streams in the room, publications not yet announced included (`409 stream_limit_reached`); one live stream per device in the room (`409 helper_busy`); since 1.14 at most one video track per `codec`, one of them H.264 (`400 invalid_message`, `path: /tracks`) | `PublishRequest`            | `201` `PublishResponse`         |
| `PUT /api/rtc/rooms/:roomId/publish/renegotiate`         | helper | the publication is this device's (`404 sfu_session_not_found`)                                                                                                                                                                                                                                                                                                                                                                                                                              | `PublishRenegotiateRequest` | `200` `RenegotiateResponse`     |
| `POST /api/rtc/rooms/:roomId/unpublish`                  | helper | same; idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `UnpublishRequest`          | `204`                           |
| `POST /api/rtc/rooms/:roomId/session`                    | web    | at most 8 viewer sessions per user per room (the oldest is forgotten)                                                                                                                                                                                                                                                                                                                                                                                                                       | `ViewerSessionRequest`      | `201` `ViewerSessionResponse`   |
| `POST /api/rtc/rooms/:roomId/subscribe`                  | web    | the session is the caller's in this room (`404 sfu_session_not_found`); the slot is live, the caller's, and for this stream (`404 slot_not_found`); the stream is announced (`404 stream_not_found`); `rid` is one of the stream's (`400 invalid_message`). Since 1.14 `codec: av1` pulls the stream's AV1 track (its top layer) when it has one, the room's `av1Presets` include its preset and the pull starts on the top layer; else the H.264 track. The answer's `codec` says which    | `SubscribeRequest`          | `200` `SubscribeResponse`       |
| `PUT /api/rtc/rooms/:roomId/renegotiate`                 | web    | the session is the caller's                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `ViewerRenegotiateRequest`  | `200` `RenegotiateResponse`     |
| `PUT /api/rtc/rooms/:roomId/layer`                       | web    | the session is the caller's and pulls that stream (`404 stream_not_found`); `rid` is one of the stream's. On an AV1 pull (since 1.14) the top layer is a no-op and any other layer `409 invalid_message`: pull again (`subscribe` with that `rid`), which gets the H.264 track                                                                                                                                                                                                              | `LayerRequest`              | `204`                           |
| `POST /api/rtc/rooms/:roomId/unsubscribe`                | web    | the session is the caller's; idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `UnsubscribeRequest`        | `204`                           |
| `POST /api/rtc/leave`                                    | web    | the session is the caller's (else `204` anyway: nothing to close); idempotent                                                                                                                                                                                                                                                                                                                                                                                                               | `LeaveRequest`              | `204`                           |
| `POST /api/rtc/rooms/:roomId/voice/publish`              | web    | since 1.10. Voice capability; the session is the caller's (`404 sfu_session_not_found`); the caller is in voice from some tab (`409 voice_not_joined`); `can(voice.speak)` and not server-muted (`403 voice_speak_not_allowed`); `mid` is an audio m-section of the offer (`400 invalid_message`, `path: /mid`): web clients publish audio only here                                                                                                                                        | `VoicePublishRequest`       | `201` `VoicePublishResponse`    |
| `POST /api/rtc/rooms/:roomId/voice/unpublish`            | web    | since 1.10. The session is the caller's; idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VoiceUnpublishRequest`     | `204`                           |
| `POST /api/rtc/rooms/:roomId/voice/subscribe`            | web    | since 1.10. Voice capability; the session is the caller's; the caller is in voice (`409 voice_not_joined`); 1–4 `trackIds`, each in the caller's `voice.tracks` (`404 voice_track_not_found { trackId }`)                                                                                                                                                                                                                                                                                   | `VoiceSubscribeRequest`     | `200` `VoiceSubscribeResponse`  |
| `POST /api/rtc/rooms/:roomId/voice/unsubscribe`          | web    | since 1.10. The session is the caller's; idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VoiceUnsubscribeRequest`   | `204`                           |
| `POST /api/rtc/rooms/:roomId/camera/publish`             | web    | since 1.12. Camera capability; the session is the caller's (`404 sfu_session_not_found`); in voice from some tab (`409 voice_not_joined`); `can(camera.publish)` (`403 camera_not_allowed`); quota brake (`403 quota_exhausted`); cameras on, the caller's own not counted (`409 camera_limit_reached { limit }`); `mid` is a video m-section with at most two `a=rid` layers (`400 invalid_message`, `path: /mid`): the microphone goes through `voice/publish`                            | `CameraPublishRequest`      | `201` `CameraPublishResponse`   |
| `POST /api/rtc/rooms/:roomId/camera/unpublish`           | web    | since 1.12. The session is the caller's; idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                         | `CameraUnpublishRequest`    | `204`                           |
| `POST /api/rtc/rooms/:roomId/camera/subscribe`           | web    | since 1.12. Camera capability; the session is the caller's; in voice (`409 voice_not_joined`); 1–4 `trackIds`, each in the caller's `voice.tracks` cameras (`404 voice_track_not_found { trackId }`); `rid` is one of each camera's layers (`400 invalid_message`, `path: /rid`)                                                                                                                                                                                                            | `CameraSubscribeRequest`    | `200` `CameraSubscribeResponse` |
| `PUT /api/rtc/rooms/:roomId/camera/layer`                | web    | since 1.12. Camera capability; the session is the caller's and pulls that camera (`404 voice_track_not_found { trackId }`); `rid` is one of its layers (`400 invalid_message`, `path: /rid`)                                                                                                                                                                                                                                                                                                | `CameraLayerRequest`        | `204`                           |
| `POST /api/rtc/rooms/:roomId/camera/unsubscribe`         | web    | since 1.12. The session is the caller's; idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                         | `CameraUnsubscribeRequest`  | `204`                           |
| `POST /api/rtc/rooms/:roomId/browser/publish`            |
| `PUT /api/rtc/rooms/:roomId/browser/publish/renegotiate` |
| `POST /api/rtc/rooms/:roomId/browser/unpublish`          |

Publishing (helper):

1. `POST .../ice` for ICE servers, gather, then `POST .../publish` with the offer and the local
   tracks (a simulcast video is **one** track with its rids `f`/`h`/`q`). The room runs
   `sessions/new` then `tracks/new` (`location: local`) with the offer and returns the SFU's
   answer. Track names are the helper's, unique within its session.
2. Within `announceWithinMs`, `stream.announce` on the room socket (section 7.2).
3. `PUT .../publish/renegotiate` when the helper's tracks change; `POST .../unpublish` at the end
   (`tracks/close` with `force: true` on every mid, then the stream ends with `ended_by_streamer`).

Publishing (browser, since 1.22). A desktop web tab
streams with its **own** peer connection and SFU session, not the viewer session:

1. `getDisplayMedia({ video: { frameRate }, audio: true, systemAudio: "include",
selfBrowserSurface: "exclude", surfaceSwitching: "include" })`; the video track gets
   `contentHint = "motion"`. `POST .../ice`, then a peer connection with a sendonly video
   transceiver whose three `sendEncodings` are the helper's layers (`f` the preset's top layer,
   `h` 720p, `q` 480p at 30 fps, `scaleResolutionDownBy` from the captured size, `maxBitrate` and
   `maxFramerate` from the same table, the top one cut to fit the room's `maxBitrateKbps`),
   `degradationPreference: "maintain-framerate"`, H.264 first in the codec preferences, and a
   sendonly Opus transceiver when the capture has audio.
2. `POST .../browser/publish { tabId, sessionDescription, tracks, preset, maxBitrateKbps }` with
   the tab's `hello.tabId`. The room runs `sessions/new` then `tracks/new` (`location: local`),
   exactly as for a helper, and answers with a `PublishResponse`.
3. Within `announceWithinMs`, `stream.announce` on the room socket of the same tab (section 7.2),
   with `layers` as encoded.
4. Under economy mode (`qualityCap` in the answer or in `stream.updated`), lower every encoding's
   `maxBitrate` to the cap (audio included); without it, back to the preset's.
5. The tab uploads a thumbnail like a helper (section 11.3): a frame drawn on a canvas, as JPEG.
6. To stop: `stream.end` and `POST .../browser/unpublish`. The user ending the share from the
   browser's own UI (`track.onended`) does the same. On `pagehide`:
   `navigator.sendBeacon('/api/rtc/rooms/:roomId/browser/unpublish', JSON.stringify({ sfuSessionId }))`.

Watching (web):

1. On entering the room: `POST .../session`, ideally with an offer carrying only a data channel.
   The room runs the TURN credential call in parallel with `sessions/new` (passing the offer) and
   returns the session id, the ICE servers (TURN URLs on port 53 removed; credentials tagged with
   the space id as `customIdentifier`) and the SFU's answer, so DTLS connects before any click.
   Without an offer, only the session is created; send the offer later through `PUT .../renegotiate`.
2. On click: `slot.request` on the room socket, then `POST .../subscribe { sessionId, slotId,
streamId, rid? }`. The room checks the slot, then pulls the stream's tracks onto the viewer's
   session in one `tracks/new` (`location: remote`): the video with `simulcast: { preferredRid,
priorityOrdering: "none", ridNotAvailable: "asciibetical" }` when the stream is simulcast, and
   the audio. The SFU's offer comes back (`requiresImmediateRenegotiation`); answer it with
   `PUT .../renegotiate`. The viewer puts audio and video in one msid stream before
   `setRemoteDescription`.
3. Layer changes: `PUT .../layer { rid }` runs `tracks/update` on the same mid (no renegotiation).
4. Stop watching: stop the stream's transceivers (`RTCRtpTransceiver.stop()`), then
   `POST .../unsubscribe`, then `slot.release`. Pulling the same stream again on the session (a
   retry, a resume, a new slot) does the same first. The force close sends no SDP and the SFU
   keeps offering the closed m-sections (`sendonly`, with their SSRCs), so a receiver left running
   gets no packets and sends a PLI every few seconds, which the SFU relays to the publisher as a
   forced IDR. On `pagehide`:
   `navigator.sendBeacon('/api/rtc/leave', JSON.stringify({ roomId, sessionId }))` (the body may
   arrive as `text/plain`), which closes every pulled track (`tracks/close`, `force: true`).

Voice (web, since 1.10, section 7.5). The same viewer session carries the voice: no
second peer connection.

1. After `voice.joined`, add a sendonly audio transceiver (Opus, `echoCancellation`,
   `noiseSuppression`, `autoGainControl`), create an offer and `POST .../voice/publish
{ sessionId, sessionDescription, mid }`. The room runs `tracks/new` (`location: local`) with the
   offer and returns the SFU's answer and the `trackId` the others will see. Publishing again
   (a new device, after a server mute) closes the previous microphone first. Mute does not
   unpublish: it stops sending (`replaceTrack(null)` or `enabled = false`).
2. For `voice.tracks`, `POST .../voice/subscribe { sessionId, trackIds }` with at most 4 tracks per
   request (one `tracks/new`, serialized per session like every call); answer the SFU's offer with
   `PUT .../renegotiate`. The response lists a `VoiceSubscribedTrack` (`trackId`, `userId`, `mid`) per
   pull. A `trackId` already pulled on the session is closed first and pulled
   again (stop its transceiver before), never pulled twice (the lesson of section 11.2 step 4).
3. `POST .../voice/unsubscribe` closes pulls; `POST .../voice/unpublish` closes the microphone.
   Leaving voice closes both on the server, and `POST /api/rtc/leave` closes them with the rest of
   the session.

Cameras (web, since 1.12, section 7.7). Also on the viewer session:

1. In voice, `getUserMedia({ video })` (640×360 at 30 fps; front camera on phones), add a sendonly
   video transceiver with two `sendEncodings`, `{ rid: "h", maxBitrate: 500000 }` and
   `{ rid: "l", scaleResolutionDownBy: 2, maxBitrate: 150000 }`, create an offer and
   `POST .../camera/publish { sessionId, sessionDescription, mid }`. The room runs `tracks/new`
   (`location: local`) with the offer and returns the answer, the `trackId` and the layers it read
   from the offer. Another camera device is `replaceTrack` on the same sender.
2. For `voice.tracks` cameras, `POST .../camera/subscribe { sessionId, trackIds, rid? }` (at most 4;
   default the lowest layer; the response lists a `CameraSubscribedTrack` per pull) answered through
   `PUT .../renegotiate`, with the camera's video and its owner's microphone in one msid stream. The room pulls with `simulcast:
{ preferredRid, priorityOrdering: "none", ridNotAvailable: "asciibetical" }`. A camera
   already pulled is closed first, never pulled twice.
3. `PUT .../camera/layer { sessionId, trackId, rid }` switches an enlarged camera to `h` and back.
4. `POST .../camera/unsubscribe` closes pulls; `POST .../camera/unpublish` turns the camera off.
   Leaving voice closes both, and `POST /api/rtc/leave` closes them with the rest of the session.

Realtime behaviour this relies on (measured during development):

- `sessions/new` with no body answers `201 { sessionId }`; with an offer it also returns the
  answer. An unconnected session can expire before first use, so viewer sessions are created when
  the room page opens, right before negotiating.
- A pull into a session returns `requiresImmediateRenegotiation: true` and an **offer**; the
  client answers through `renegotiate`.
- There is no "close session" call: closing is `tracks/close` with `force: true` (no SDP).
- `tracks/update` switches a simulcast subscriber's layer on the same mid; it refuses to put
  another track on a non-simulcast mid.
- `status: active` does not mean media flows, and errors come at three levels (see above).
- TURN `generate-ice-servers` returns URLs on port 53, which browsers block.

The room stores every Realtime session id it creates in D1 (`realtime_sessions`: session, space,
room, user, kind, time) so real egress can be reconciled per space. The kind is
`publish` (a helper), `browser_publish` (a browser tab, since 1.22) or `view`.

### 11.3 Stream thumbnails

Since 1.6. While live, the helper uploads a small JPEG of what it streams every 10 s, so the room's
cards show the stream without pulling video. A thumbnail shows the screen, so it has the stream's
access rules: it lives in a **private** R2 bucket, one object per stream, and only the Worker
serves it, checking the room access of the caller on every request.

| Route                                                    | Caller | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                         | Request                      | Response                                                                   |
| -------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `PUT /api/rtc/rooms/:roomId/streams/:streamId/thumbnail` | helper | device token, or since 1.22 a web session, and room access as in 11.2; the stream is this device's (for a web session: the caller's own browser stream) and live (`404 stream_not_found`); `Content-Type: image/jpeg` (`415 invalid_message`, `path: ""`); at most 64 KiB (`413 invalid_message`); one upload per 4 s per stream (`429 rate_limited { retryAfterMs }`); while the stream is paused, only the placeholder (`409 stream_paused`) | JPEG bytes                   | `204`                                                                      |
| `GET /api/streams/:streamId/thumbnail`                   | any    | session or device; `can(room.view)` on the stream's room, like the room socket, on **every** request; an unknown stream, one without a thumbnail and one the caller may not see are all `404 not_found`                                                                                                                                                                                                                                        | — (`If-None-Match` honoured) | `200` `image/jpeg`, `Cache-Control: private, max-age=10`, `ETag`; or `304` |

- The helper marks the paused placeholder with the header `X-Openlive-Thumbnail: paused`: one
  upload when the curtain (or a pause) starts, instead of any frame. The room accepts nothing else
  while the stream is paused, and deletes the last real thumbnail the moment it hears the pause.
- The URL has no permanent form: clients add `?v=<thumbnailAt>` only to refresh their cache, and
  the server ignores it.
- Viewing a thumbnail is not watching: it needs no slot and is not counted.
- Objects are deleted when the stream ends; the scheduled sweep removes any that remain.

### 11.5 Profile photos (Settings → Profile)

REST only; no message changes. Every `avatarUrl` (members, presence, the admin user list, `GET
/api/me`) is either Discord's CDN URL or, for an uploaded photo, the same-origin path
`/api/avatars/:userId/:version`, which needs the session cookie. Clients use it as is. The web
app crops and resizes the photo to a 256 × 256 WebP before uploading it.

| Route                               | Caller             | Checks                                                                                                                                                                                                                                              | Request                      | Response                                                                             |
| ----------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `PUT /api/me/avatar`                | signed-in web user | `Content-Type` `image/webp`, `image/png` or `image/jpeg`, matching the first bytes (`415 invalid_message`, `path: ""`); at most 512 KiB (`413 invalid_message { limit }`); 10 uploads per hour (`429 rate_limited { retryAfterMs }`)                | image bytes                  | `200 { user, avatar }`; `user.avatarUrl` is a new versioned path                     |
| `DELETE /api/me/avatar`             | signed-in web user | —                                                                                                                                                                                                                                                   | —                            | `200 { user, avatar }`; no photo (initials), also after later Discord logins         |
| `POST /api/me/avatar/discord`       | signed-in web user | the account has a Discord photo (`404 not_found`)                                                                                                                                                                                                   | —                            | `200 { user, avatar }`; later Discord logins keep it current                         |
| `GET /api/avatars/:userId/:version` | signed-in web user | `can(user.avatar.view)`: oneself, the platform admin, or someone who shares a live space with them (member of any role, or a guest of one of its rooms); an unknown user, an old version and a photo the caller may not see are all `404 not_found` | — (`If-None-Match` honoured) | `200` image, `Cache-Control: private, max-age=31536000, immutable`, `ETag`; or `304` |

- `avatar` (also in `GET /api/me`) is `{ source: "discord" | "upload" | "none", discordAvailable }`.
  `discord` also means "no photo yet" when `avatarUrl` is null.
- A Discord login records Discord's photo and shows it only while the person has not uploaded or
  removed one.
- Each person has one object, `avatars/<userId>` in the private bucket, overwritten by each upload
  and deleted with the photo or the account. Only the current version is served, so a cached old
  URL never shows a newer photo and a removed photo is gone at once.
- A new name or photo reaches open rooms when the person's socket reconnects (it carries them),
  and REST lists on their next fetch.

### 11.4 Metrics (since 1.7)

| Route                      | Body                   | Answer | Who                                        |
| -------------------------- | ---------------------- | ------ | ------------------------------------------ |
| `POST /api/metrics/viewer` | `ViewerMetricsRequest` | `204`  | A signed-in viewer with access to the room |

The player aggregates `getStats()` over about 30 s per watched stream and posts one
`ViewerMetricsRequest`; a last, shorter window goes out with `keepalive` when the watch view
closes. The Worker checks room access, then writes one Analytics Engine data point (ids, never
names or addresses). Errors: `invalid_message`, `unauthenticated`, `forbidden` /
`room_not_found` (as the room socket), and `rate_limited` with `retryAfterMs` beyond 10 posts a
minute per user.

### 11.6 Mobile app login (since 1.18)

The mobile app connects to any instance. It signs in through the system
browser, in the native-app pattern of RFC 8252 with PKCE (RFC 7636): the instance's normal login
(Discord or e-mail), a consent page, then a redirect to `openlive://auth` with a one-time code that
the app exchanges for an **app token**. The helper's pairing (section 11.1) is unchanged.

| Route                                | Caller                         | Request               | Response (success)            |
| ------------------------------------ | ------------------------------ | --------------------- | ----------------------------- |
| `GET /.well-known/openlive.json`     | anyone                         | —                     | `200` `InstanceInfo`          |
| `GET /app/authorize?…` (web page)    | signed-in person, in a browser | query, below          | redirect to `openlive://auth` |
| `POST /api/app/authorize`            | that page (browser session)    | `AppAuthorizeRequest` | `200` `AppAuthorizeResponse`  |
| `POST /api/app/token`                | the app, no credentials        | `AppTokenRequest`     | `200` `AppTokenResponse`      |
| `DELETE /api/app/token`              | the app (app token)            | —                     | `204`                         |
| `POST /api/app/ws-ticket`            | the app (app token)            | —                     | `200` `AppWsTicketResponse`   |
| `GET /api/me/sessions`               | signed-in person or app        | —                     | `200` `{ sessions }`          |
| `DELETE /api/me/sessions/:sessionId` | signed-in person or app        | —                     | `204`                         |

1. **Instance description.** `GET /.well-known/openlive.json` is public and the same for everyone
   (no cookie read, nothing about any person): `name` (the host name until instances can be
   named), `iconUrl`, `version` and `commit` (as `/api/health`), `protocol { min, max }` (the app
   speaks to the instance if its major is between the two; within a major, section 1's rules
   apply), and `features`: `app_login`, `ws_ticket`, `invite_deep_link`, and
   `capability:<stream|voice|camera|text>` for each room capability the platform allows. Clients
   ignore feature names they do not know. `Cache-Control: public, max-age=300` and
   `Access-Control-Allow-Origin: *`.
2. **Authorization.** The app makes a `code_verifier` (43–128 characters), its S256
   `code_challenge` and a random `state`, and opens in the system browser (never a WebView):
   `/app/authorize?client=openlive-mobile&redirect_uri=openlive://auth&code_challenge=…&code_challenge_method=S256&state=…&device_name=…`.
   The page requires the normal login and keeps the whole query through it (`returnTo`, up to
   1024 characters). A person opening an invite in the app (`openlive://join?instance=…&invite=…`)
   adds the optional `&invite=<token>` (the invite's 43 base64url characters; anything else is
   ignored). The login page reads it from `returnTo` as it does for `/invite/<token>`, so on an
   `invite_only` instance a new account can be created (the invite is only checked, no use is
   taken). The authorize page itself ignores `invite`; the app
   accepts the invite afterwards with its app token. `client` and `redirect_uri` must be exactly these values, the method `S256`,
   `state` 1–128 printable ASCII characters, `device_name` 1–64 characters; anything else gets an
   error page and **no redirect** (RFC 6749 4.1.2.1). The page asks "Allow 'Openlive' on
   <device_name> to use your account on <instance>?":
   - **Allow** posts `AppAuthorizeRequest` (the same values, camelCase) and sends the browser to
     the answer's `redirectTo`: `openlive://auth?code=<code>&state=<state>`. Only a browser
     session may (`403 forbidden` for an app or device token); `20` approvals per person per 10
     minutes. The code is single use, valid **2 minutes**, and bound to the client, the redirect
     URI and the challenge.
   - **Deny** sends the browser to `openlive://auth?error=access_denied&state=<state>`.
3. **Token.** The app checks `state` and posts `AppTokenRequest { code, codeVerifier, client,
redirectUri }`. The code is consumed by the first attempt, whatever its outcome; an unknown,
   used or expired code, a verifier that does not hash to the challenge, or another client or
   redirect URI are all `400 app_code_invalid` (one code, so nothing can be probed). Attempts are
   limited per IP (`429 rate_limited`). The answer (`Cache-Control: no-store`) carries the
   **app token** once (`ola_` + 43 characters; the server keeps its SHA-256), its `tokenId` and
   the `user`.
4. **Using the token.** `Authorization: Bearer <token>` on the REST API. The app is its user on
   every route, with the same `can()` answers as the browser, **except the platform admin's
   powers**: `isPlatformAdmin` reads `false`, so `/api/admin/*` answers `403 forbidden` and a
   suspended space stays closed. A request with an app token and no cookie skips the
   Origin check (the app is not a browser; no site can make a browser send that header); with a
   cookie it gets the full check. A bearer is never retried as a cookie. The token works until it
   is revoked or goes **90 days unused** (each use moves the expiry); then `401 unauthenticated`,
   and the app signs in again.
5. **Sockets.** `POST /api/app/ws-ticket` answers a single-use ticket (`olt_` + 43 characters),
   valid **60 s**, for one upgrade: `/ws/hub?ticket=…`, `/ws/spaces/:spaceId?ticket=…` or
   `/ws/rooms/:roomId?ticket=…`. A URL with a ticket is judged by the ticket alone (never by a
   cookie); a used, expired or unknown ticket, or one of a revoked token, is `401
unauthenticated`. At most 20 unused tickets per token (`429 rate_limited`). Tickets because
   React Native's WebSocket does not send custom headers the same way on every platform; the
   bearer header is accepted on the upgrade too. The app says `client: "web"` in `hello`.
6. **Sessions and revocation.** `GET /api/me/sessions` lists browsers (`kind: "browser"`, as
   before) and apps (`kind: "app"`: `id` (the `tokenId`), `createdAt`, `deviceName`,
   `lastUsedAt`, `current`), newest first. `DELETE /api/me/sessions/:id` with an app's id, or
   `DELETE /api/app/token` from the app itself, revokes the token: its open sockets (hub, spaces,
   rooms) get `error session_expired` and close with **4001**, which also takes it out of a voice
   channel, and its unused tickets go.

### 11.7 What happened while the app was away (additive, no protocol bump)

The mobile app has no push, so when it opens after some time it asks what it missed:

1. **Unread and mentions.** `GET /api/spaces/:spaceId/chat/unread` (7.6) also answers `mentions: {
[roomId]: number }`: how many of the unread messages mention the caller (capped at 100, rooms
   without any are left out).
2. **Streams that started.** `GET /api/spaces/:spaceId/streams/recent?since=<ms>` → `{ streams: [{
streamId, roomId, userId, userName, startedAt }] }`, newest first, at most 20, the streams that
   started after `since` (never further back than 7 days) in the open rooms the caller may see
   (a restricted room only for those with access; the caller's own streams are left out).
   `400 invalid_message` (`/since`) for a bad `since`, `404` outside the space. The room writes a
   `stream_starts` row in D1 when a stream is announced (migration 0015) and deletes week-old rows
   as new ones arrive; it keeps no title, viewers or media. One D1 read per call.

## 12. Changing the protocol

1. Edit this document.
2. Edit the schema in `packages/protocol/schema/` (one file per message in `messages/`, named
   `<type>.json`, plus the `x-openlive` metadata: phase, channels, senders, receivers, replies).
3. Add valid and invalid fixtures under `packages/protocol/fixtures/`.
4. `pnpm --filter @openlive/protocol generate`, then `test` (TypeScript) and `go test ./...` in
   `packages/protocol/go`.
5. Bump the minor version in `schema/envelope.json` (`x-openlive.protocolVersion`) and at the top
   of this document when the change ships.
