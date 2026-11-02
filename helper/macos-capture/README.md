# openlive-capture (macOS sidecar)

The macOS capture backend of the helper: a small Swift program that captures a
display or a window with **ScreenCaptureKit**, encodes the simulcast layers with **VideoToolbox**
(hardware H.264) and an app's audio as **Opus**, and hands everything to the Go helper over a
Unix socket. The Go side is `helper/internal/media/macos.go` (the `MediaBackend`) and
`helper/internal/sidecar` (the wire format). The same binary is the helper's **desktop agent**
(`agent`): the menu bar item, UserNotifications and the global shortcuts while `run` is up
(`helper/internal/macagent`).

```
openlive-capture list                          displays, windows and apps, as JSON
openlive-capture thumbnail --source display:1 [--max 320x180]   a JPEG on stdout (macOS 14+)
openlive-capture doctor                        Screen Recording permission and encoders, as JSON
openlive-capture capture --fd 3 | --socket P   serve one capture to the helper (the helper starts it)
openlive-capture agent --fd 3 | --socket P     menu bar item, notifications, shortcuts (the helper starts it)
openlive-capture bench [flags]                 capture + encode without the helper, print a report
openlive-capture version
```

Needs macOS 13 or later (ScreenCaptureKit audio, low-latency H.264) and Apple silicon or an
Intel Mac with a hardware H.264 encoder. Thumbnails need macOS 14.

## Build, sign, install

```sh
cd helper/macos-capture
swift build -c release                       # .build/release/openlive-capture
swift test                                   # the wire-format tests
codesign --force --sign "$MAC_SIGN_IDENTITY" --identifier dev.hfps.openlive.capture .build/release/openlive-capture
```

The helper looks for the sidecar in `$OPENLIVE_CAPTURE`, then next to its own binary, then in
an app bundle's `Contents/Helpers/` or `Contents/Resources/`. For a development build, put both
side by side:

```sh
cd helper && go build -o build/openlive-helper ./cmd/openlive-helper
cp macos-capture/.build/release/openlive-capture build/
codesign --force --sign "$MAC_SIGN_IDENTITY" --identifier dev.hfps.openlive.helper build/openlive-helper
```

Then wrap the sidecar in the development app bundle, which the agent needs for notifications
(see "App bundle"); the helper prefers `build/OpenliveHelper.app/Contents/MacOS/openlive-capture`
to the bare binary, for the captures too:

```sh
MAC_SIGN_IDENTITY=... ./bundle.sh .build/release/openlive-capture ../build
```

`MAC_SIGN_IDENTITY` is your signing identity: the SHA-1 or the name that
`security find-identity -v -p codesigning` prints (an "Apple Development" certificate is enough
for development). Do not commit it.

**Why sign:** macOS keeps the Screen Recording permission (TCC) per code identity. An unsigned
or ad-hoc-signed build (what `swift build` and `go build` produce) has a new identity on every
build, so macOS asks again after each rebuild. Signed with the same certificate and identifier,
the permission survives rebuilds.

## Permissions

Only **Screen Recording** (System Settings > Privacy & Security > Screen & System Audio
Recording). The app audio comes from ScreenCaptureKit, so the Microphone permission is not
used.

macOS asks the **responsible process**: the app that started the helper. The sidecar the helper
starts counts as the helper, so `openlive-helper` (or the Terminal you started it from) is the
one to turn on; `openlive-capture` needs its own switch only when run alone (`bench`, `list`).
The first capture shows the system prompt; after turning the switch on, start again (macOS may
offer "Quit & Reopen", which is not needed).

ScreenCaptureKit only works in the logged-in **GUI session**. A process started over SSH is
outside it (`list` fails as if the permission were missing). To run tests over SSH, start them
through launchd in the GUI domain: write a LaunchAgent plist with the command and
`ProcessType Interactive`, then `launchctl bootstrap gui/$(id -u) <plist>` and, when done,
`launchctl bootout gui/$(id -u)/<label>`. `launchctl asuser` needs root on macOS 26. The login
keychain is also only unlocked in the GUI session, so `codesign` over SSH fails with
`errSecInternalComponent` and works the same way.

## Pipeline

- **Capture.** One `SCStream` per stream: `SCContentFilter(display:)` or
  `SCContentFilter(desktopIndependentWindow:)`, NV12 (`420v`, BT.709), at the top layer's size
  (the helper fits the layers to the source's aspect ratio; ScreenCaptureKit letterboxes a
  resized window into the fixed size), queue depth 6, cursor on unless `--hide-cursor`. The
  minimum frame interval is 2/3 of the top layer's: on a display whose refresh is not a multiple
  of the layer's rate (175 Hz), capturing at exactly 1/60 s lands on every third tick, 58 fps.
  Each layer keeps its own clock of due times and takes the frames it needs from the faster
  capture, so a 60 fps layer averages 60.0 on a 175 Hz display.
- **Scale.** The lower layers are scaled on the GPU (`VTPixelTransferSession`, letterbox) into
  IOSurface pools of their size; nothing touches the pixels on the CPU.
- **Encode.** One `VTCompressionSession` per layer, hardware only, with **low-latency rate
  control** (`EnableLowLatencyRateControl`), real time, constrained baseline, no frame
  reordering (no B-frames), the bitrate as `AverageBitRate` plus a `DataRateLimits` cap of the
  bitrate over the VBV window (250 ms by default: no window carries more, which bounds an IDR as
  the VBV does on Linux), the 10 s GOP as a fallback, and `ForceKeyFrame` on request.
  A bitrate change applies in place: VideoToolbox emits no IDR for it, so the limit follows the
  new bitrate over the same window. Each layer encodes on its own queue with at most 3 frames in
  flight; a frame over that is skipped before encoding (`busy` in the stats), never after, so a
  layer that is more than the hardware holds runs at what it holds instead of stalling the
  capture. The output is turned into Annex B with SPS and PPS before every IDR.
- **Still screen.** ScreenCaptureKit sends nothing while nothing changes. The last frame is
  encoded again after 250 ms without one (a 4 fps floor), and at once for a key frame request,
  so a viewer joining a still screen gets its IDR right away. The helper takes each frame's
  duration from the presentation times, so the RTP clock follows the real gaps.
- **Audio.** A second `SCStream` whose filter **includes one app only** (the shared window's,
  or the one picked with `--audio-app`, with its helper processes such as
  `com.google.Chrome.helper`), with `excludesCurrentProcessAudio`, 48 kHz stereo. The browser in
  an Openlive voice channel is therefore never captured unless it is the app shared; that case
  shows the browser warning (the helper reports the app's bundle id as its binary). AudioToolbox
  encodes Opus at 128 kbit/s in 20 ms packets (`AVAudioConverter`).
- **Window state.** For a window, the sidecar checks every second whether it is still there and
  on screen: a closed window ends the stream (`ended`), a minimized or hidden one pauses it
  (`hidden`, `source_hidden`) until it is back (`shown`).
- **Privacy curtain.** `curtain 1` makes every layer encode a black frame (NV12 video range,
  made once at the capture size) instead of the screen, at once and then at the capture's pace
  (or the 4 fps floor), and the app audio is encoded as silence, so the encoders, the tracks and
  the SFU's layers keep running, as on Linux. The capture goes on, but no thumbnail is taken.
  `curtain 0` puts the screen back; the helper then asks every layer for a key frame, which on a
  still screen encodes the last real frame at once. Measured: 60 fps of black at ~130 kbit/s,
  8 Mbit/s again right after it lifts.
- **Thumbnails.** With `thumbnail` in the config, a 320-pixel-wide JPEG of the capture every
  2 s for the stream card (Core Image, on the GPU).

## Socket protocol

The helper makes a `socketpair` and passes one end as fd 3 (`capture --fd 3`); `--socket PATH`
connects to a listening socket instead (manual tests). Every message is:

```
u32  length (big-endian) of what follows
u8   type
...  payload
```

| Type                 | Direction        | Payload                                                                                                                                                                                                                                                               |
| -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x01` hello         | sidecar → helper | JSON `{protocolVersion, version, os}`, sent first                                                                                                                                                                                                                     |
| `0x02` started       | sidecar → helper | JSON `{width, height, encoder, audioApp?: {name, bundleId, pid}}`                                                                                                                                                                                                     |
| `0x03` video         | sidecar → helper | `u8 layer` (index in the config), `u8 flags` (bit 0: key frame), `u64 pts` (ns, host clock), `u32 encode time` (µs), then one H.264 Annex B access unit                                                                                                               |
| `0x04` audio         | sidecar → helper | `u64 pts` (ns), `u32 duration` (µs), then one Opus packet                                                                                                                                                                                                             |
| `0x05` stats         | sidecar → helper | JSON for the last second: `captured`, `idle`, `repeated`, `dropped` (writer behind), `captureDelayMsAvg`, `cpuPercent`, `audioPackets`, and per layer `frames`, `dropped` (by the encoder's rate control), `busy`, `keyframes`, `bytes`, `encodeMsAvg`, `encodeMsMax` |
| `0x06` error         | sidecar → helper | JSON `{code, message, fatal}`; codes `permission`, `source_not_found`, `encoder`, `audio`, `capture`, `protocol`, `usage`                                                                                                                                             |
| `0x07` event         | sidecar → helper | JSON `{event: ended \| hidden \| shown, width?, height?}`                                                                                                                                                                                                             |
| `0x08` thumbnail     | sidecar → helper | a JPEG                                                                                                                                                                                                                                                                |
| `0x09` menu click    | agent → helper   | JSON `{id}`: a menu item clicked                                                                                                                                                                                                                                      |
| `0x0a` hotkey        | agent → helper   | JSON `{action}`: a global shortcut pressed                                                                                                                                                                                                                            |
| `0x0b` hotkeys bound | agent → helper   | JSON `{results: [{action, trigger, ok, conflict?, error?}]}`, the answer to hotkeys                                                                                                                                                                                   |
| `0x0c` notifications | agent → helper   | JSON `{state: authorized \| denied \| unavailable, bundle?, error?}`, once known and on every change                                                                                                                                                                  |
| `0x20` config        | helper → sidecar | JSON `{source: {kind: display \| window, id}, layers: [{rid, width, height, fps, kbps, vbvMs}], gopSeconds, cursor, audio?: {pid?, bundleId?, kbps?}, thumbnail?: {width, everyMs}}`, sent once after hello                                                           |
| `0x21` keyframe      | helper → sidecar | `u8 layer`                                                                                                                                                                                                                                                            |
| `0x22` bitrate       | helper → sidecar | `u8 layer`, `u32 kbps`                                                                                                                                                                                                                                                |
| `0x23` fps           | helper → sidecar | `u8 layer`, `u16 fps`                                                                                                                                                                                                                                                 |
| `0x24` stop          | helper → sidecar | empty: stop and exit                                                                                                                                                                                                                                                  |
| `0x25` curtain       | helper → sidecar | `u8` 1 on, 0 off: the privacy curtain                                                                                                                                                                                                                                 |
| `0x26` menu          | helper → agent   | JSON `{icon: idle \| live \| paused \| curtain, tooltip, items: [{id, label?, enabled?, separator?, checked?}]}`, replaces the menu bar item                                                                                                                          |
| `0x27` notify        | helper → agent   | JSON `{id, title, body?, critical?, transient?}`; the same id replaces a notification                                                                                                                                                                                 |
| `0x28` hotkeys       | helper → agent   | JSON `{bindings: [{action, trigger, keyCode, modifiers}]}` (Carbon key code and modifier bits), replaces every shortcut                                                                                                                                               |

Messages are at most 32 MiB. The sidecar exits when the socket closes (the helper is gone).
A sidecar of another `protocolVersion` (2 since the curtain and the agent) is refused, so the
two are built and shipped together. The agent says hello like a capture and gets no config;
`stop` quits it.
`Tests/CaptureProtocolTests` and `helper/internal/sidecar/wire_test.go` check the same byte
vectors.

The writer queue never drops an encoded frame: when more than 8 MiB wait to be written, new
captured frames are dropped before encoding (`dropped` in the stats) until it drains.

## Agent

`openlive-capture agent --fd 3` runs for as long as `run` does, apart from the captures (which
come and go with each stream, so a failed capture never takes the menu bar item with it). It is
an accessory app (no Dock icon, no main menu) whose AppKit run loop drives:

- **The menu bar item** (`NSStatusItem`). The helper computes the menu with the Linux tray's code
  and sends it whole on every change; the agent shows it and sends back the clicked item's id,
  which the helper maps against its current menu. Icons are SF Symbols: template images for
  idle (`dot.radiowaves.left.and.right`), paused (`pause.circle`) and the curtain
  (`eye.slash.circle.fill`), and a red `record.circle.fill` while live.
- **Notifications** through `UNUserNotificationCenter`, which only works in a process with a
  bundle identity: run from the app bundle, the agent asks for permission (macOS's prompt, once)
  and reports the state, also when it changes in System Settings (checked every 30 s). Outside a
  bundle it reports `unavailable` and the helper keeps `osascript`.
- **Global shortcuts** as Carbon hot keys (`RegisterEventHotKey` with `kEventHotKeyExclusive`).
  They need no Accessibility or Input Monitoring permission (an event tap would). A combination
  another app registered fails with `eventHotKeyExistsErr` and comes back as a conflict.

## App bundle

`bundle.sh` makes the development bundle the agent needs:

```
OpenliveHelper.app/
  Contents/Info.plist        CFBundleIdentifier dev.hfps.OpenliveHelper, LSUIElement, LSMinimumSystemVersion 13.0,
                             NSScreenCaptureUsageDescription, CFBundleExecutable openlive-capture
  Contents/MacOS/openlive-capture
```

signed with `MAC_SIGN_IDENTITY` (ad hoc without it) and registered with Launch Services. The helper
itself stays outside the bundle in development: the Screen Recording permission is granted to
`openlive-helper` (the responsible process), and moving it into a bundle would need a new grant.
The captures run from the bundle's binary too; macOS still asks `openlive-helper`.

**The release app** (`packaging/macos/build-app.sh`) keeps what this bundle fixed:
the bundle id `dev.hfps.OpenliveHelper` (the notification permission and the Screen Recording
grant are tied to it), `LSUIElement`, and the sidecar in **`Contents/MacOS/`**, now next to
`openlive-helper`, which is the `CFBundleExecutable` (a binary in `Contents/Helpers/` would not
get the bundle's identity, so UserNotifications would refuse it; the helper finds the sidecar next
to itself first). Both binaries are universal and signed with the Developer ID and the hardened
runtime (the sidecar as `dev.hfps.OpenliveHelper.capture`, no entitlements), and the app is
notarized. The helper being inside the bundle, the app itself is the responsible process and gets
the one Screen Recording grant.
