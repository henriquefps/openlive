# Changelog

All notable changes to Openlive. The server (Worker and web app) and the helper share one version.
The wire protocol has its own version, in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Unreleased

## 0.1.8 (2026-11-10)

**Changed**

- New app icon: an olive square with a one-colour glyph, a monitor and its stand with a solid
  "live" circle in front. The web app (favicon, PWA icons, header mark), the mobile app, the helper
  (tray, Linux and macOS icons), the README header and the social preview use it.

**Added**

- Stream from the browser, without the helper (protocol 1.22). On a desktop browser the Go live
  panel offers "Stream from the browser": the browser asks what to share (a screen, a window or
  a tab, with its sound where the browser allows it) and the tab streams at up to 1080p60, with
  the helper's three quality layers. It is a fallback with limited quality: the helper stays the
  recommended way (up to 1440p and 120 fps, one app's sound, lower CPU). With a helper online the
  panel is as before, with a link to the browser option; without one, it leads with installing
  the helper and offers the browser second (on Windows, where there is no helper yet, it says so).
  While live: resolution, frame rate and bitrate, pause, 1080p30 or 1080p60, stop; the stream
  ends 15 s after the tab closes. Viewers need nothing new; cards show a small "Browser" badge.
- Limits monitor and brake. Every 5 minutes the server reads today's Cloudflare figures for each
  Workers, Durable Objects and D1 limit (and on Workers Paid the month's), stores them for the
  admin panel, and e-mails the platform admins at 50 %, 70 % and the brake's share, once a day
  each. At the brake's share (80 % by default, 50 to 95 %, or off) the instance pauses itself
  before Cloudflare's limit: room, space and hub connections and the API calls that reach them
  are refused with "Paused by this instance's limits brake" (503 / close 1013, reason
  `limits_brake`), and the rooms that were awake close their sockets and stop their alarms. Login
  and the admin panel keep working. It releases at 00:00 UTC (on a Paid monthly budget, when the
  month turns over), or by hand from the admin panel's new Limits brake card, which also engages
  it by hand. On Workers Paid the budget is a share of the month's included amounts and/or a
  maximum overage in USD a day. The figures are account-wide, which is why it stops below 100 %.
  The cron now runs every 5 minutes; the usage copy and the sweeps keep their 15.

**Self-host and costs**

- A circuit breaker inside every room, space and user hub object stops one that goes wild before
  it can use up the Cloudflare Durable Objects daily limits. Each object counts its alarms,
  requests and WebSocket messages in memory; far above any real use (for example, more than 120
  alarms in a minute) it stops for 10 minutes: its alarm is deleted, it refuses everything, and
  the trip is logged once and shown on the admin and space status pages. A single socket that
  floods the server with messages is closed on its own. A busy room never comes near the limits.

**Fixed**

- An expired quick room no longer runs its alarm in a loop. After closing the room at its expiry,
  the room kept the past expiry as a deadline and re-armed an alarm that fired at once, forever,
  until Cloudflare refused requests for exceeding the Durable Objects free tier. The room now
  closes once for its expiry and never schedules it again, and a deadline still due after the
  alarm ran is retried a minute later instead of at once. A chat message exactly at its retention
  deadline is deleted by that sweep instead of left due.

## 0.1.7 (2026-11-06)

**Android app (beta)**

- Switches (for example "Sons de aviso", the notification sounds) are drawn in the theme colors
  instead of the system's teal thumb.
- The update banner shows the download size in the same decimal MB as GitHub (73.2 MB).

## 0.1.6 (2026-11-06)

- Web: on phones the space page's sections (rooms, members, invites, requests, status, settings)
  are a dropdown instead of a scrolling tab strip that hid the last ones; it shows the pending
  requests count, with a dot when requests has items and another section is open.
- Web: color palettes. Next to Light, Dark and System you can pick Olive (default), Blue, Violet,
  Rose or Graphite, from the theme menu or Settings; the choice is saved in the browser. Live,
  error and warning colors stay the same in every palette.
- The Download page links straight to the helper files in the public GitHub release, with their
  SHA-256, instead of serving them from the server's own storage: the server still offers exactly
  the version its admin pinned, but no download goes through the Worker and no copy sits in R2.
  `pnpm run helper:publish -- --from-release X.Y.Z` now writes only the manifest (check the
  assets exist and are in `SHA256SUMS`); builds you upload yourself (`--version`, `--mac-dmg`) are
  served from the server as before. A fork with its own releases sets `HELPER_RELEASE_REPO`.
- The Android card has a direct "Download APK (X.Y.Z)" button with the SHA-256, set with
  `pnpm run helper:publish -- --android-from-release X.Y.Z`; without it the card links to the
  Android releases as before.

**Android app (beta)**

- Theme: light, dark or system, with the same five color palettes as the web (Olive, Blue, Violet,
  Rose, Graphite); the interface is restyled like the web.
- Space management: rooms, members, invites, join requests, status and settings, and creating
  fixed and quick rooms. You can also create a space.
- Join a room by code, room link or invite. The room menu shares the code and link and manages
  features, access, archive or end.
- Settings has sessions, devices and notification toggles.
- The servers screen shows a banner when a newer Android version is published on the server you
  use; it opens the APK of the official release.

## 0.1.5 (2026-11-03)

**Android app (beta)**

- The microphone works again: the 0.1.4 APK did not declare the microphone permission (a photo
  picker setting removed it), so voice said it had no access without ever asking. The release
  build now refuses an APK that lacks the permissions the app needs.

## 0.1.4 (2026-11-02)

- Global voice shortcuts through the helper: push-to-talk, mute and deafen work while a game has
  the focus (protocol 1.21, `helper.voiceShortcut`). Settings > Voice and the voice bar say when a
  helper provides them; the keys are in the helper's config file (`talk`, `mute`, `deafen`).
- The web calls an instance a "server" in what people read, and hides its address when the address
  is already its name.
- App sign-in carries an invite, so new people can sign up from the app on invite-only servers
  (protocol 11.6).
- The web and the upcoming Android app share one client library (`packages/client`) for the API,
  sockets, chat, watching and voice.

**Android app (beta)**

- The Android app is out as a beta, installed by sideloading the APK from the GitHub Releases
  (`android-v0.1.4`); it is not on the Play Store. Android 7 or later, arm64 and armv7.
- Add servers by address, QR code or invite link, and keep several; sign in through the system
  browser.
- Spaces, rooms and text chat with mentions, edit and delete; the live streams of a room with
  quality, queue and landscape full screen.
- Voice with photos and cameras, push-to-talk, per-person volume and moderation; voice keeps
  running in the background with the screen locked, from a notification with Mute and Leave.
- Sound cues, toasts and a summary of what happened while you were away.
- Profile (name, photo) and personal settings.

## 0.1.3 (2026-11-02)

Helper fixes.

- Video no longer drifts seconds behind the audio. The helper stamped every video frame with
  the nominal frame time, so a still screen, a Wayland capture that only sends changed frames or
  a capture restart (resizing the shared window) slowed the video clock down; viewers' jitter
  buffers grew up to about 10 s while the audio stayed on time. Video timestamps now follow real
  time on Linux and macOS.
- The helper announces the protocol it really speaks (1.20; it said 1.12). The web no longer
  calls it outdated, and the voice sink and the "Allow visual clicks" switch in Go live show up.

## 0.1.2 (2026-11-02)

The first public release.

**Watch**

- Streams in any recent browser, on desktop or phone, with automatic quality and a manual
  override, theater mode, picture in picture, full screen and stats for nerds.
- First frame in about 0.4 s; a queue when a stream is full; background tabs and idle viewers
  stop receiving video but keep their seat.

**Stream**

- A native helper for Linux (Wayland, through the portal and PipeWire; NVENC, VA-API or x264)
  and macOS 13 or later (ScreenCaptureKit and VideoToolbox, signed and notarized).
- Screen or single window with that app's sound; start, pause (privacy curtain), change quality
  and stop from the web. Presets up to 4K60 (native resolution), and 1080p120 and 1440p120 when the admin allows
  120 fps, sent as simulcast layers.
- Visual clicks, if the streamer allows them: a viewer clicks the video and a pulsing marker with
  their name and their chosen color and shape shows on the streamer's screen. KDE Plasma for now.

**Talk**

- Voice per room: mute, deafen, push-to-talk, devices, volume per person, server mute.
- Cameras in voice with a call layout that fills the screen: side by side, a grid, you in a
  corner in a call of two, a click to pin someone, voice-only people in a compact strip.
- Text chat per room with mentions, edit and delete, unread badges and the retention the room
  chooses (none, 7, 30 or 90 days).

**Rooms and access**

- Spaces, fixed rooms and quick rooms with a join code; invite links with roles, approval and
  expiry; restricted rooms, bans and an audit log.
- Sign in with Discord or a magic link by e-mail. English and Brazilian Portuguese.
- On phones, forms open as bottom sheets, tables become card lists and detail panels take the
  full screen.

**Self-host and costs**

- One command sets up an instance on your own Cloudflare account and deploys it
  ([docs/self-host.md](docs/self-host.md)).
- A monthly bandwidth limit with brakes, an economy mode near it, ceilings per platform, space
  and room, and a platform overview with usage, cost and playback health.
