# Openlive mobile app

The Openlive app for Android (iOS later): it connects to **any** Openlive instance, like a
Mastodon or Jellyfin app. This first version adds instances, signs in to them and lists your
spaces, their rooms with live presence, each room's chat and live-stream list, and the stream
player (below); voice comes next.

- Expo (SDK 58) with **development builds** (`expo prebuild`, no Expo Go): the native modules the
  app needs later (WebRTC, background audio) do not run in Expo Go.
- Android application id and iOS bundle id `dev.hfps.openlive`; URL scheme `openlive://`.
- Light, dark or system, in five color palettes (as the web); English and Brazilian Portuguese follow the system language.

## What it does

- **Add an instance** by typing its address, scanning a QR code (an address, an invite page, or an
  `openlive://join` link), or opening an invite's "Open in app" link
  (`openlive://join?instance=https://…&invite=<token>`). The app reads
  `/.well-known/openlive.json`, shows the instance's name and icon, and checks that its protocol
  range holds this app's major version and that it offers `app_login`.
- **Sign in** in the system browser (Custom Tabs on Android, never a WebView) with PKCE S256 and a
  random `state`; the instance redirects to `openlive://auth?code=…&state=…`, and the app exchanges
  the code at `POST /api/app/token` for an **app token** (docs/PROTOCOL.md, section 11.6). The
  consent page names the phone by its model.
- **Several instances**, each with its own token in the Android Keystore (expo-secure-store).
  Tap an instance on the list to switch to it; its screen shows who is signed in and their spaces.
- **Sign out** revokes the token on the instance (`DELETE /api/app/token`) and forgets it. A token
  that was revoked in Settings → Sessions or expired (`401`) asks you to sign in again.
- **Invites**: after a join link, the instance screen shows the invite and accepts it.
- **Spaces and rooms** (`@openlive/client`): tap a space to see its rooms with who is in voice, who
  is streaming (the space socket, live) and unread chat counts; pull down to refresh. A room opens
  its own socket (`POST /api/app/ws-ticket` before every connect): who is here, the live streams
  as cards with a Watch button (the player is a placeholder in `src/player/` until it lands) and
  the chat: history as you scroll up, send, edit and delete your own (long-press a message),
  `@mentions` highlighted with suggestions, links open in the browser, the room's retention shown.
  Reconnecting, ended rooms and errors say so in the screen's language.
- A request that comes back `401` forgets the token and takes any open space or room back to the
  server's screen, which asks to sign in again.

## Profile and settings

- Open them from the avatar at the top right of a server's screen (the profile of that server), or
  from the gear on the server list (the settings of this phone only).
- **Profile**, per server (`GET/PUT /api/me`, `PUT/DELETE /api/me/avatar`, `POST /api/me/avatar/discord`
  through `@openlive/client`): the name, and the photo from the gallery (the system photo picker) or
  the camera, cropped square by the system and sent as 256 x 256 WebP (JPEG outside Android), the
  same limits as the web (`src/lib/avatar.ts`, `src/photo.ts`). A change updates the cached profile
  and the saved server, and drops the cached room and space snapshots so the next room shows it.
  An uploaded photo is a path on the server that needs the token: `Avatar` loads it with the
  app token inside `AvatarSourceProvider`.
- **This phone**: language (system, English, Portuguese), theme (system, light, dark), palette (olive, blue,
  violet, rose, graphite) and language under the web's keys `openlive.theme`, `openlive.palette` and
  `openlive.language`, and the push-to-talk default (the shared
  voice prefs, `openlive.voice`). They live in `voicePrefsStore` (`src/voice/store.ts`), so other
  personal prefs (the notices) can use the same store.
- **Sign out of this server** asks first.

## Spaces list, join by code and room menu

- **Spaces list** (the server's screen): create a space (name and address with the web's slug rule,
  hidden when the server restricts creation: `canCreateSpace`), skeletons while it loads, an error
  with retry, `/s/slug` under each name. **Join** takes a quick room's code or `/join` link, or an
  invite link or token pasted in the same field (`src/lib/join-input.ts`).
- **Home**: "Join a room with a code" opens a sheet (pick the server when several are signed in,
  type the code, or scan a QR code); a joined room opens at once.
- **Room menu** (the dots in the room's header, `src/screens/room/RoomMenu.tsx`): the quick room's
  code and link to share (the system share sheet; no clipboard module yet), features, access of a
  restricted room, archive or end. Permissions from `canManageRoom` and `isManager` of
  `@openlive/client` (`src/lib/room-menu.ts`). It never touches the player or the voice session.
- **Settings**: notices on or off per kind, and, per server, the sessions (revoke) and the paired
  helpers (revoke).

## Theme and UI kit

- **Theme** (`src/theme.ts`, `src/lib/palette.ts`, `src/lib/color.ts`): `useTheme()` returns
  `{ colors, dark, mode, modeChoice, palette, setMode, setPalette }`. The mode (`light`, `dark`,
  `system`, key `openlive.theme`) is forced on the OS color scheme in `src/settings.ts`; the palette
  (`olive` default, `blue`, `violet`, `rose`, `graphite`, key `openlive.palette`) is independent.
  The tokens are the web's (`apps/web/src/index.css`) converted from OKLCH to sRGB by
  `oklchToCss` (a color outside sRGB loses chroma, as in a browser). Olive lists its values; the
  other four derive from the web's `--nh --nc --bh --bc` with the same lightness values, and
  `live`, `destructive` and `warning` are the same in every palette. `test/theme.test.ts` checks
  the conversion, that every palette has every token, the saved-value fallback and WCAG contrast.
- **Kit** (`src/components/ui/`, import from `components/ui/index.ts`), all themed and typed:
  - `Button`: `variant` default / outline / ghost / destructive, `size` default / sm / icon, `icon`, `busy`.
  - `Card`: radius 12, hairline border, lighter than the background in dark; `onPress` makes it a button.
  - `Badge`: tones primary / secondary / muted / destructive / live / warning / outline.
  - `Input` and `Field` (with a label): 44 px, ring color while focused, `invalid`.
  - `SectionSelect`: the phone's SpaceSectionSwitcher. `sections` with optional `badge`; 2 or 3 are a
    segmented control, 4 or more a full-width select that opens a bottom sheet. Rules in `src/lib/section-select.ts`.
  - `SwatchPicker`: choices with a color (the palette picker).
  - `EmptyState` (icon, title, description, actions), `Skeleton`, `Separator`.
  - `PageHeader`: a compact "‹ Parent" line that is the back control, then title (or a skeleton while
    it loads), description and actions. Back goes to the PARENT level, which in the stack is the screen below.
  - `Screen` (`components/ui.tsx`) wraps `PageHeader` and the scroll area; pass `backLabel` = the parent's name.

## Audio

Watching a stream plays as **media**, not as a phone call: the volume keys move the media volume,
Bluetooth headphones use A2DP (stereo), and the speaker or the connected output is the one the
phone uses for video. (react-native-webrtc's default is a voice-call channel: call volume and the
Bluetooth headset profile.)

- `plugins/with-openlive-audio.js` (an Expo config plugin; `expo prebuild` regenerates `android/`)
  builds the WebRTC audio device with `USAGE_MEDIA` / `CONTENT_TYPE_MOVIE` and installs it in
  `MainApplication.onCreate`, before WebRTC starts (`WebRTCModuleOptions.audioDeviceModule`).
- `modules/openlive-audio/` is a small local Expo module (Android) that sets the AudioManager mode,
  the volume keys' stream (`setVolumeControlStream`) and audio focus.
- `src/audio/` is the API, one mode at a time:

  ```ts
  import { setAudioMode, releaseAudio } from './audio/index.ts';
  setAudioMode('media'); // watching: MODE_NORMAL, STREAM_MUSIC keys, focus GAIN as a movie
  setAudioMode('communication'); // talking (A3): MODE_IN_COMMUNICATION, call-volume keys,
  // transient focus as a voice call
  releaseAudio(); // nothing playing: focus, mode and keys back to the system
  ```

  The player sets `media` while it is open and releases it on close. Voice (A3) calls
  `setAudioMode('communication')` while it is on and `setAudioMode('media')` when it ends while a
  stream is still being watched (otherwise `releaseAudio()`). Echo cancellation and the microphone
  belong to voice. The playout's own attributes (`USAGE_MEDIA`) are fixed when the audio device is
  built at start-up, so voice has to make the device switch on its own (a new device or an
  attributes setter) if the call-volume path matters for what it plays.

- **Audio focus** reaches the player as `gain` / `duck` / `loss_transient` / `loss` and sets the
  stream's gain (`focusGain` in `src/audio/mode.ts`): another app's music or a phone call mutes the
  stream (the video keeps going); a notification ducks it to 30 %; it comes back at full when focus
  returns, and the app asks for focus again when it comes to the foreground after a permanent loss.

## Voice on the phone (A3-M)

The native groundwork for voice on Android, with no voice logic: A3's voice client calls this API
to keep a call alive. `src/voice-native/` is the API (a tested state machine, `session.ts`, bound to
`modules/openlive-audio` in `native.ts`).

```ts
import {
  requestMicPermission,
  startVoiceSession,
  stopVoiceSession,
  onNotificationAction,
  setRoute,
  voice,
} from './voice-native/index.ts';

if ((await requestMicPermission()) !== 'granted') return; // explains why first; 'blocked' offers Settings
const { device, notifications } = await startVoiceSession({
  roomName: 'general',
  serverName: 'Home',
  serverAddress: 'openlive.example.com',
});
onNotificationAction((a) => {
  if (a === 'leave') {
    /* leave the room */ stopVoiceSession();
  }
});
voice.setMuted(true); // keeps the notification's button right (the client mutes the track)
setRoute('speaker'); // 'speaker' | 'earpiece' | 'auto'
stopVoiceSession(); // end of the call; safe to repeat
```

- **`startVoiceSession`** (needs the microphone permission, else `VoiceSessionError('mic_permission')`):
  asks for notifications (Android 13+) and Bluetooth (12+) without requiring them; sets the audio
  mode to `communication` (`MODE_IN_COMMUNICATION`, call volume on the keys); swaps WebRTC to the
  voice audio device; starts the foreground service; applies the route. Any failure undoes the
  earlier steps. `stopVoiceSession` reverses them, and goes back to `media` if a stream is still
  being watched (otherwise releases the audio). While voice is on, the player's `setAudioMode` /
  release calls only decide what the mode returns to.
- **Voice audio device.** The WebRTC audio device is fixed when a `PeerConnectionFactory` is built
  (the media one uses `USAGE_MEDIA`), so `OpenliveWebrtcBridge` (in `react-native-webrtc`'s package,
  to reach `WebRTCModule.mFactory`) builds a **second factory** once: `USAGE_VOICE_COMMUNICATION`,
  `VOICE_COMMUNICATION` mic source, hardware AEC and noise suppression when the phone has them
  (software AEC otherwise). `mFactory` points at it during a session and back at the media one
  after. A peer connection keeps the factory it was created with: a stream being watched when voice
  starts keeps playing as media; **create the voice peer connection after `startVoiceSession`**, and
  a stream opened during the call plays through the call path. Neither factory is disposed.
- **Foreground service** `VoiceSessionService` (type `microphone|mediaPlayback`, Android 14 rules:
  the microphone permission is checked before, the app must be on screen when it starts), with a
  CPU wake lock and a Wi-Fi lock so the call survives the screen locking. **Notification**
  "In voice in #room" (the server's name and address as text, a call timer), with **Mute / Unmute**
  and **Leave**: they come back as `onNotificationAction('mute' | 'unmute' | 'leave')`. The session
  applies mute itself (notification text and `snapshot.muted`); the voice client acts on the events.
  `leave` with no listener ends the session; with a listener that does not call
  `stopVoiceSession` within 3 s it is forced. The notification shows on the lock screen
  (public visibility), so mute works from there.
- **Swiping the app away ends the call**: `onSessionEnded('task_removed')` goes to JavaScript to
  leave the room; 3 s later the service stops and, if the app is still not on screen, the process is
  killed so nothing holds the microphone. `onSessionEnded` also reports `service_stopped` (the
  system stopped it).
- **Route**: `auto` (wired, then Bluetooth, else the speaker), `speaker`, `earpiece`. Android 12+ uses
  `setCommunicationDevice` (Bluetooth SCO and LE Audio headsets, hearing aids, USB); older versions
  the speakerphone switch and Bluetooth SCO. Plugging in or removing a headset re-routes `auto` and
  reports `snapshot.active` / `available`.
- **Permissions** (`app.json`): `RECORD_AUDIO`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE` (+ `_MICROPHONE`,
  `_MEDIA_PLAYBACK`), `BLUETOOTH_CONNECT`. `requestMicPermission()` shows the reason first, then the
  system question; "never ask again" shows a dialog with the app's Settings.
- Android only: on iOS or without the module `voice.supported` is false and `startVoiceSession`
  rejects with `unsupported`. CallKit and `UIBackgroundModes` are for later.

### Voice test screen

On the first screen, tap the version line five times; "Voice test (debug)" opens a bench:
start and stop a session, mute, the route buttons, the hardware AEC/NS and device-swap report, the
last notification event, a **microphone level meter** and the two permission requests.

### Try it on a phone (manual script)

1. Install the build, open the app, tap the version five times, open "Voice test (debug)".
2. Tap "Microphone permission": the explanation, then the system's question. Allow. Same for
   notifications.
3. Tap "Start session": "In a session", audio mode `communication`, and the notification
   "In voice in #test" with the server and a running timer appears (pull the shade down).
   "Voice audio device: yes".
4. Tap "Start meter" and talk: the bar moves. Stop the meter.
5. Press Power to lock the screen and **wait 5 minutes**. Wake it: the notification is still there
   with the timer running (about 5 min more), and the lock screen showed it with Mute and Leave.
6. From the lock screen or the shade tap **Mute**: the button turns to "Unmute", and in the app
   "Last event" shows `mute` and the button says "Unmute". Tap Unmute.
7. With headphones (wired or Bluetooth) plugged in, "Playing through" changes to wired or
   bluetooth under Auto; unplug: back to speaker. Try Earpiece and Speaker.
8. Tap **Leave** in the notification: the session ends, the notification goes, audio mode `-`.
9. Start again and **swipe the app away** from the recent apps: the notification disappears in
   about 3 s and the microphone indicator goes off.
10. Watch a stream (player), start a session from the test screen (open it with the player closed,
    or start a stream first and come back): the stream keeps playing as media; stop the session
    and the volume keys go back to media volume.

## Voice in rooms (A3-V)

A room that has voice shows a **Voice** section on its screen: Join voice, then the call stage and
the controls.

- **Parts.** `src/voice/host.ts` holds the app's one `VoiceSessions` (packages/client), so the call
  outlives the room screen; `parts.ts` builds a room's session: its own room socket (a second "tab"
  next to the screen's and the player's), its SFU session (opened only while in voice,
  `rtc: 'voice'`), and the shared `VoiceClient` and `CameraClient` over react-native-webrtc.
  `phone-voice.ts` wraps the client with what a phone adds: microphone permission, then the call
  (foreground service, notification, communication audio mode, `voice-native`), then the join; the
  notification's Mute / Leave act on the client; any end of the voice (leave, kick, room closed,
  service killed) ends the call and returns the audio to media.
- **Speaking ring.** react-native-webrtc has no AnalyserNode: `levels.ts` reads `audioLevel` from the
  session's stats (one `getStats()` every 200 ms for all tracks) into the shared level monitor.
- **Controls.** Mute, deafen, camera and flip, push-to-talk (a setting: open mic or push-to-talk;
  push-to-talk shows a big hold-to-talk button), per-person volume 0-200 %, audio route
  (automatic, speaker, earpiece; a headset shows when present and automatic uses it), leave. A
  moderator muting you shows "A moderator muted you".
- **Moderation** (person menu: long press a tile or its menu button): mute / unmute for everyone,
  remove from voice, turn their camera off, by `personMenuAbilities` (packages/client), the web's
  PersonMenu rule: `canModerate` and `canActOn`.
- **Cameras.** The web's call layout (`stage-layout.ts` moved to packages/client; the web imports it
  from there): gallery that fills the stage, voice-only people in a strip, your own picture-in-picture
  in a 1:1 call, tap to pin (spotlight), high simulcast layer by tile size.
- **Background** (`rules.ts`): voice keeps the room socket and SFU sessions with the screen locked
  or another app in front; only the player's watch slot is released. The camera is closed when the
  app leaves the front (Android takes it away anyway). Coming back, or a Wi-Fi / cellular change,
  retries a socket that was waiting at once; the SFU session replaces itself and voice publishes
  again.
- **Watching while in voice.** The audio mode stays `communication` (echo cancellation) and the
  stream plays through the same output; leaving voice puts the player back on media audio.
- **Bar.** Out of the room screen, a bar at the bottom shows "Voice connected", Mute, Leave and the
  way back.

Limits: Android only. A speaker/earpiece/headset choice is a preference; with two headsets the
system picks. If the stats' `trackIdentifier` does not match the track id on a device, the speaking
ring stays off (voice itself is unaffected).

### Try it on a phone (voice, manual script)

Needs a room with voice (and cameras) and a second person on web or another phone.

1. Open the room, tap Join voice, allow the microphone. A "In voice in #room" notification
   appears. The other person sees you; speak: their tile for you rings, and yours rings for them.
2. Mute / Unmute in the app, then in the notification: both stay in step. Deafen: you hear nobody.
3. Settings > Push to talk: the big button appears; the microphone is open only while held (also
   with the finger sliding off the button).
4. Person menu: change someone's volume (0-200 %, remembered). As owner/admin: mute for everyone
   ("A moderator muted you" on their side), turn their camera off, remove from voice. As a member
   there are no moderation items.
5. Turn the camera on, flip front/back. Others' cameras fill the stage; tap one to pin it; in a 1:1
   you float in a corner. Weak network pauses cameras, voice stays.
6. Route: speaker / earpiece / headset in the Audio output sheet.
7. Press Home, then open another app: voice continues, the notification stays. Lock the screen.
8. Watch a stream while in voice: you hear it and the voice, no echo; close it, voice goes on. Leave
   voice with a stream open: it stays and plays as media.
9. Switch Wi-Fi to cellular (and back) while in voice: it reconnects without leaving.
10. Navigate back out of the room: the bottom bar keeps Mute / Leave. Leave from the notification:
    everything stops.
11. **Exit criterion (A3):** 4 people in voice, one on this phone with the screen locked for 30
    minutes, without dropping. Check the notification is still there and you still hear and are
    heard at the end.

## Saved data (cache)

Screens open with the last data they showed and refresh it in the background (TanStack Query,
`@tanstack/react-query`, the same major as the web app):

- **REST reads** (spaces, a space's rooms, unread counts, invite previews) are queries with a
  `staleTime` (15 s to a minute): a screen shows the cached answer at once, and fetches again when
  it is older than that, when the app returns to the front, when the network comes back, and on
  pull to refresh. Accepting an invite refreshes the spaces.
- **Socket screens** (a space's presence, a room's members and streams, a room's chat) start from
  the last snapshot of their socket, kept in the same cache, and replace it with the live
  snapshot; every socket event updates the entry, so going back shows current data. Until the
  welcome arrives the existing "connecting / reconnecting" banner says so; nothing goes blank and
  no spinner covers content. Sending, editing and deleting chat messages stay socket requests; their
  results reach the cache through the chat state.
- **No network**: a muted "Offline. Showing saved data." strip appears when a screen has saved data,
  instead of an error screen. Requests wait for the network and run when it returns.
- **On the phone**: the cache is one JSON entry in AsyncStorage (`openlive.query-cache.v1`), written at
  most once a second, so a cold start shows the last screens too. AsyncStorage is what Expo SDK 58
  bundles and autolinks; the cache is small and read once at start, which MMKV (an extra native
  module) would not speed up. `src/lib/cache.ts` has the rules, `src/lib/persister.ts` the storage.

What is stored, and what is not:

| Stored                                                                                          | Never stored                                                                                              |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Spaces, rooms, unread counts, the last presence / room (members, streams) snapshots             | App tokens (they stay in secure storage), mutations                                                       |
| Chat: only rooms with a retention above zero days, the newest 100 messages, not over 7 days old | Chat of a room with retention "none", of a quick room, or of unknown retention; unsent or failed messages |
|                                                                                                 | Invite previews (an invite token is not for keeping)                                                      |

- Every key is `['ol', server origin, signed-in user id, kind, ...]`: servers and users never share
  an entry. Entries of a server or user that is not signed in are dropped when the app starts.
- A server's cache is wiped (memory and disk) on sign out, when a request comes back `401` or the
  session was revoked, when the server is removed, and (other users' entries) on a sign-in as
  someone else.
- The cache carries a "buster" (format and app version): a new app version starts empty. Saved
  data older than 7 days is not used.
- A room with no retention keeps its messages in memory only while its screen is open.
- The player (`src/player/`) keeps its own socket and does not touch the cache; no WebRTC state is
  cached.

## Watching a stream

`src/player/` has `StreamView` (props `{ instance, roomId, streamId, onClose }`), which the room
screen renders for a stream. It uses the shared watch path in `@openlive/client` (the same code
the web runs) with `react-native-webrtc` (an Expo config plugin, so a development or release build,
never Expo Go):

- **Slot and queue**: the view opens its own room socket (like a second browser tab), asks for a
  viewer slot (`slot.request`), keeps it alive (`slot.renew`) and gives it back when the view
  closes. A full stream shows its queue: join, position, the 30 s offer to accept (docs/PROTOCOL.md
  7.3).
- **Pull**: once the slot is granted, the room's SFU session (`/api/rtc/...`, 11.2) pulls the
  stream and `RTCView` renders it. A stall pulls again with backoff; a lost session pulls on a new
  one.
- **Quality**: Automatic (starts on the top layer, steps down after a bad stretch and up after a
  stable one) or a fixed layer, from the layers the helper reports (`StreamInfo.layers`, 1.19).
- **AV1**: asked for only when the device lists an AV1 decoder (`RTCRtpReceiver.getCapabilities`)
  and the stream has an AV1 top layer; leaving the top layer or a stalled AV1 pull falls back to
  H.264. react-native-webrtc decodes AV1 **in software** on Android (MediaCodec
  hardware decoding is used for H.264 only), so Automatic stepping down is what protects a phone
  that cannot keep up.
- **Rotation**: the app is portrait everywhere except in the player, which follows the phone:
  turning it to landscape enters full screen (the video fills the screen, controls overlay, status
  and navigation bars hidden), turning back leaves it. It respects the system's auto-rotate; with
  it off, the full-screen button still works and forces landscape (held until the button, or the
  back button, leaves it). After leaving by the button, portrait is held for 2 s and the sensor is
  followed again. Leaving the player always restores portrait. The logic is `rotation.ts`.
- **Cellular**: on a cellular connection (`expo-network`) Automatic starts on the middle layer,
  like the web's `navigator.connection` rule and like economy mode (a stream with a `qualityCap`);
  a layer picked by hand always wins.
- **"Still watching?"** (brake 6): after 2 hours without touching the player a dialog asks, and
  without an answer in 60 s watching stops and the slot goes back (the player closes). The
  server can turn it off for everyone (`viewerBrakes.idleCheck` in `/api/me`).
- **Metrics**: the same playback windows the web posts (first frame, freezes, dropped frames, layer,
  reconnects, ...) go to `POST /api/metrics/viewer` every 30 s and when the watch ends. They come
  from `MetricsReporter` in `@openlive/client`.
- **Controls**: volume and mute (the audio track's own gain), full screen (forces landscape),
  stats overlay (resolution, fps, bitrate, loss, jitter buffer, round trip, codec, layer, decode
  time, time to first frame), back button.
- **Phone rules**: the screen stays on while a stream plays (`expo-keep-awake`). In the background
  the media stops after 10 s (the slot is kept) and the slot is given back after a minute; coming
  back asks for a slot again.
- Android permissions for playback only: `INTERNET`, `ACCESS_NETWORK_STATE`,
  `MODIFY_AUDIO_SETTINGS`, `WAKE_LOCK`. The plugin also declares `RECORD_AUDIO` and `BLUETOOTH`;
  `app.json` blocks them until publishing from the phone exists (`CAMERA` stays for the QR scanner).

`controller.ts` is the state machine (no React, no WebRTC, tested in `test/player-controller.test.ts`;
rotation and cellular are in `test/player-rotation.test.ts`);
`rtc.ts` binds the shared session and source to react-native-webrtc; `useWatch.ts` wires the room
socket, the session and the controller to React; `StreamView.tsx` is the screen.

### Try it on a phone

1. Install the build (an APK from "Build an APK" below) and sign in to an instance that has a room
   with a helper streaming (or a test stream: `openlive-helper test-stream --room <roomId>`).
2. Open the room and tap the stream. **First frame**: video appears within a couple of seconds;
   "Stats" shows the time to first frame, codec and layer.
3. **Quality**: tap the quality button, pick a lower layer. The video keeps playing (no black
   frame longer than a second) and the stats show the new resolution. Pick Automatic again.
4. **Full-screen button**: tap "Landscape": the screen turns, the status and navigation bars hide,
   the video fills it. The Android back button leaves landscape first.
   4b. **Rotation** (system auto-rotate **on**): with the stream in portrait, turn the phone to
   landscape: it enters full screen by itself; turn it back: it leaves. Turn it to landscape in the
   room screen (not the player): the app stays portrait. Leave the player from landscape: the app
   is portrait again.
   4c. **Rotation, auto-rotate off**: turn the system's auto-rotate off. Turning the phone does
   nothing, the button still forces landscape, and tapping it again (or Back) returns to portrait.
   4d. **Cellular**: turn Wi-Fi off and use mobile data, pick Automatic: it starts on the middle layer
   (720p), not the top one. Pick the top layer by hand: it stays there.
   4e. **Still watching?**: this takes 2 hours, so run a debug build with a shorter time or trust
   `test/player-controller.test.ts`; when the dialog is up, "Keep watching" continues, and no
   answer for 60 s closes the player and gives the slot back.
   4f. **Metrics**: after watching a minute, the space's status page (or Analytics Engine) shows the
   viewer windows with this phone's layer and first-frame time.
5. **Volume**: mute, then step the volume up (unmutes).
6. **Background**: press Home. After about 10 s the helper's viewer count for you stays, after a
   minute it drops (the slot went back). Open the app again: the stream returns.
7. **Back releases the slot**: tap Back. In the web room the viewer count drops at once, and
   a second phone or tab can take the slot (set a viewer limit of 1 to see the "full" screen and
   the queue on the second one).
8. **Reconnect**: turn Wi-Fi off for 10 s and on again: "Reconnecting…", then the video returns.

## Icons

Icons are [Phosphor](https://phosphoricons.com) (`phosphor-react-native`, on `react-native-svg`),
the same family as the web app: regular weight, filled for active states. Never emojis or symbol
glyphs as icons: ESLint rejects them in `apps/mobile/src` and `apps/web/src`.

## Layout

```
index.ts                 entry point
app.json                 Expo config: ids, scheme, icons, plugins (camera, fonts, secure store)
src/App.tsx              navigation (a small stack) and deep links
src/state.tsx            the instances, their tokens and the login flow
src/lib/                 pure TypeScript, tested with Vitest:
  pkce.ts                verifier, S256 challenge, state, authorize URL, redirect parsing
  instance.ts            address normalisation, well-known parsing, protocol compatibility
  deeplink.ts            openlive://join, openlive://auth and scanned QR codes
  storage.ts             the instance list and one token per instance (secure storage)
  api.ts                 @openlive/client with the instance URL, a bearer token, a timeout and
                         the `network` error
  navigation.ts          the stack of screens and what back or a lost session does
  presence.ts            a space's rooms with voice, live and unread
  room-view.ts           stream cards, the connection notice, why a room ended
  chat-view.ts           who may edit or delete, mentions, retention line
  chat-text.ts           a message split into text, links and mentions
  cache.ts               cache keys, what may be saved, the wipe of a server's data
  snapshots.ts           socket state to a saved snapshot, and a snapshot as the first screen
  persister.ts           the cache as one throttled, sanitised entry in a key-value store
src/hooks.ts             the client of an instance, the space and room sockets and the chat as
                         React state, seeded from the cache
src/queries.ts           the REST reads and the invite mutation as TanStack queries
src/cache/client.ts      the QueryClient, AsyncStorage persistence, online / focus wiring
src/screens/             Home (the list), AddInstance, Scan, Instance (spaces), Space, Room
src/components/          ui.tsx (building blocks), ChatPanel.tsx
src/voice-native/        the phone side of voice: session state machine, native binding
src/player/              StreamView: the stream player (controller, react-native-webrtc binding)
src/i18n/                i18next with en and pt-BR: the shared texts of @openlive/client with the
                         app's own on top
src/theme.ts             the hfps palette (olive, Inter) for light and dark
test/                    unit tests
```

`android/` and `ios/` are generated by `expo prebuild` from `app.json` and never committed.

## Update banner (Android)

The Servers screen shows an "Update available" card when a signed-in instance offers a newer app
than the one installed. Each instance serves the Android release manifest at
`GET /api/helper/android` (members of a space or platform admins; `403`/`404` mean no info). The
app asks every signed-in instance with its own token, at most once a day (react-query `staleTime`
of 24 h, so also on a cold start when stale), never GitHub directly, and never persists the answer
(`src/app-update.tsx`; the pure rules are in `src/lib/app-update.ts`). Any failure is silent.

- The versions are compared as `X.Y.Z` (invalid values are ignored); the highest across servers
  wins. **Download** opens the manifest's APK link (a public GitHub release asset) with the
  system, which downloads it and offers to install over the app. The **x** stores the dismissed
  version under `openlive.updateDismissed`; a newer version shows the card again.
- The instance admin publishes the manifest with
  `pnpm run helper:publish -- --env production --android-from-release X.Y.Z`.
- Safety: the manifest comes from any server you added, so the app only accepts the exact link
  `https://github.com/henriquefps/openlive/releases/download/android-v<version>/openlive-<version>-android.apk`
  of the official repository (`RELEASE_REPO`), with the same version as the manifest and no port,
  credentials, query or fragment. An instance with another `HELPER_RELEASE_REPO` shows no banner.
- Limitation: a rebuild with the **same** version (or an older one) does not trigger the banner.
- Nothing is shown on iOS.

## Develop

From the repository root (`pnpm install` once):

```sh
pnpm --filter @openlive/mobile typecheck
pnpm --filter @openlive/mobile test
```

With a development build installed on a phone (below, `assembleDebug`), run Metro and the app loads
the JavaScript from it:

```sh
cd apps/mobile
pnpm start
```

## Build an APK

The build needs macOS or Linux with the Android SDK (Android Studio installs it), a JDK 17 or 21
(Android Studio's bundled JBR works), Node.js 26 and pnpm 12. The steps below build a
**release-style APK**: the JavaScript bundle is inside, so it runs without Metro. The release build
is signed with our own key (see "Release APK from main" below); without the signing variables it
fails on purpose, it never uses the debug key. For a quick local APK use `./gradlew assembleDebug`
(debug key, needs Metro) or set the variables to any keystore of yours.

```sh
# Tools (once), if Node 26 and pnpm are not installed: a private copy in the build folder.
mkdir -p .tools && cd .tools
curl -fsSLO https://nodejs.org/dist/v26.12.1/node-v26.12.1-darwin-arm64.tar.xz
tar xf node-v26.12.1-darwin-arm64.tar.xz && cd ..
export PATH="$PWD/.tools/node-v26.12.1-darwin-arm64/bin:$PATH"
npm install -g pnpm@12.15.0

# Environment (macOS paths of Android Studio; adjust on Linux).
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"

# Dependencies, the native project, the APK.
pnpm install --frozen-lockfile --filter @openlive/mobile...
cd apps/mobile
pnpm exec expo prebuild --platform android --no-install
cd android
./gradlew assembleRelease
```

The APK is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. Install it with
`adb install -r app-release.apk`, or copy it to the phone and open it (allow installing from that
source).

The APK holds every Android ABI (about 90 MB). For a phone only (about a third of that), add
`-PreactNativeArchitectures=arm64-v8a` to the Gradle command.

For a **development build** (loads the JavaScript from Metro, with the dev menu), run
`./gradlew assembleDebug` instead: `android/app/build/outputs/apk/debug/app-debug.apk`.

After changing `app.json` or adding a native module, run `expo prebuild --platform android --clean`
again.

### Building on a Mac over SSH

The repository's maintainers build on a Mac reached over SSH, from a folder of its own that holds
only a snapshot of the commit:

```sh
git archive HEAD | ssh <mac> 'mkdir -p ~/openlive-mobile-build && cd ~/openlive-mobile-build && tar xf -'
ssh <mac>
cd ~/openlive-mobile-build   # then the steps above
```

### Release APK from main

The APK for friends is signed with a private upload key that lives only on the Mac, in
`~/.openlive-keys/` (`openlive-upload.jks` and `openlive-upload.properties`, mode 600/700, alias
`openlive-upload`, RSA 4096, valid 10000 days). The Expo plugin `plugins/with-openlive-signing.js`
adds a `release` signing config to the prebuilt `android/app/build.gradle`; it reads
`OPENLIVE_UPLOAD_STORE_FILE`, `OPENLIVE_UPLOAD_KEY_ALIAS`, `OPENLIVE_UPLOAD_STORE_PASSWORD` and
`OPENLIVE_UPLOAD_KEY_PASSWORD` from Gradle properties or the environment, and a release build fails
with a clear message when one is missing. Nothing secret is in the repository.

From Linux, sync a commit into a folder of its own on the Mac and build it (the build number is the
commit count, see Versioning):

```sh
C=origin/main; N=$(git rev-list --count $C)
git archive $C | ssh <mac> 'mkdir -p ~/openlive-mobile-build-x && cd ~/openlive-mobile-build-x && tar xf -'
ssh <mac> "cd ~/openlive-mobile-build-x && ln -sfn ~/openlive-mobile-build/.tools .tools && OPENLIVE_BUILD_NUMBER=$N scripts/mobile/build-android-release.sh"
```

`scripts/mobile/build-android-release.sh` loads the key properties, installs, prebuilds, builds
arm64-v8a plus armeabi-v7a (older phones), verifies the signature with `apksigner`, refuses a
build signed with the debug certificate, prints the certificate SHA-256, and copies the result to
`~/openlive-mobile-build/dist/openlive-<version>-android.apk` with a `.sha256` file.

**Back up `~/.openlive-keys/`** (an encrypted copy outside the Mac). Android only installs an update
signed with the same key as the installed app: if the key is lost, every friend must uninstall and
reinstall (and loses the app's saved data). Never commit it or paste the passwords anywhere.

The certificate SHA-256 of the current key, to check an APK (`apksigner verify --print-certs
openlive-*-android.apk`, lowercase hex without colons there):

```text
C5:0F:EF:E1:F7:C2:DB:45:CE:34:AD:06:C9:6D:BC:87:29:A6:DE:80:1A:52:76:FF:53:D3:0E:03:5E:DA:9C:16 (keytool)
c50fefe1f7c2db45ce34ad06c96dbc8729a6de801a5276ff53d30e035eda9c16 (apksigner)
```

### Publish a release (GitHub)

The APK is distributed as a beta **pre-release** `android-v<version>` on the public repository
(github.com/henriquefps/openlive), next to the helper's `helper-v` releases. After building (above)
and exporting the matching commit to the public repository (`pnpm export:public`, see the root
CLAUDE.md), from Linux:

```sh
scripts/release/android-release.sh <version> --mac <ssh host of the Mac> --dry-run
scripts/release/android-release.sh <version> --mac <ssh host of the Mac> [--target <public commit sha>]
```

It copies the APK and its `.sha256` from the Mac into `dist/`, checks the checksum and that the
APK is signed with the expected certificate (the constant `EXPECTED_CERT_SHA256` in the script,
the apksigner value above), then creates a **draft** pre-release with the APK, its `.sha256` and
`SHA256SUMS`, and release notes from `scripts/release/android-release-notes.md.tmpl` plus the
"Android app (beta)" part of the version's `CHANGELOG.md` entry. The tag points at `--target`, the
public commit the build matches (default: the head of the public `main`). The script never
publishes: look at the draft, then publish it on GitHub. The web's Download page links to the
releases (`apps/web/src/lib/android-app.ts`).

### Versioning

`versionName` is the `version` in `apps/mobile/package.json` (the release line shared with the
server and the helper; `app.config.js` copies it to the Expo config, so the in-app version is the
same). `versionCode` is `(major * 10000 + minor * 100 + patch) * 10000 + build`, where `build` is
the commit count of the built commit (`OPENLIVE_BUILD_NUMBER`, or `git rev-list --count HEAD` in a
checkout). A new version always raises the code, and two builds of one version are ordered by
commit, so updates always install over older ones. Example: 0.1.4 at commit 150 is 1040150.

### Install on Android (sideload)

1. Send the `.apk` to the phone (messaging app, cloud drive, USB). Optionally check the file with the
   `.sha256` file.
2. Open the file. Android asks to allow installing apps from that source (Settings, Apps, Special
   access, Install unknown apps): allow it for the app you opened the file from.
3. Google Play Protect may warn that the app is from an unknown developer ("Send for scanning" or
   "Install anyway"): the app is not on the Play Store, so this is expected. Choose "Install anyway".
4. Open Openlive and sign in with the invite link from your server (open the link on the phone, or
   scan its QR code from the app).

Updates: install the newer APK over the old one; the signature is the same, so data is kept.

### Player diagnostics

Build with `EXPO_PUBLIC_OPENLIVE_DEBUG=1` and the player logs one `OLDBG` line per second to logcat
(`adb logcat -s ReactNativeJS`): layer, codec, fps, decode time, loss and the raw inbound-rtp
counters (frames received/decoded/dropped, freezes, PLI/NACK, decoder implementation).
