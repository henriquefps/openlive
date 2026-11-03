# Changelog

All notable changes to Openlive. The server (Worker and web app) and the helper share one version.
The wire protocol has its own version, in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## 0.1.4 (2026-11-02)

- Global voice shortcuts through the helper: push-to-talk, mute and deafen work while a game has
  the focus (protocol 1.21, `helper.voiceShortcut`). Settings > Voice and the voice bar say when a
  helper provides them; the keys are in the helper's config file (`talk`, `mute`, `deafen`).
- The web calls an instance a "server" in what people read, and hides its address when the address
  is already its name.
- App sign-in carries an invite, so new people can sign up from the app on invite-only servers
  (protocol 11.6).
- The web and the upcoming Android app share one client library (`packages/client`) for the API,
  sockets, chat, watching and voice. The Android app is not released yet.

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
