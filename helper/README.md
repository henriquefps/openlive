# openlive-helper

The native streaming helper. It has three `MediaBackend`s:

- the **synthetic test source** ("helper de teste"): a moving test pattern with a
  frame counter and a millisecond wall clock (so latency can be read on the viewer), encoded as
  three simulcast layers, plus a 440 Hz Opus test tone;
- the **Linux screen backend**: a monitor or a window through the Wayland
  ScreenCast portal and PipeWire, scaled on the GPU, NVENC or VA-API (x264 as the fallback), plus the
  audio of one app;
- the **macOS screen backend** (added after the Linux backend): a display or a window through the Swift sidecar
  `openlive-capture` (`macos-capture/`: ScreenCaptureKit + VideoToolbox), plus the audio of one
  app ("macOS" below).

## Commands

```sh
openlive-helper pair --instance https://openlive.example.com   # device pairing, token into the keyring
openlive-helper run [--test-source] [--encoder auto|nvh264|va|va-lp|x264] [--layers f,h,q] [--vbv 250ms] [--capture-path auto|gl|cpu] [--test-pattern ball [--test-size WxH]] [--minimized]   # stay connected in the tray; the web starts and stops streams
openlive-helper autostart enable|disable|status [--instance URL]   # start "run" with the desktop session (off by default)
openlive-helper test-stream --room <roomId> [--preset 1080p60] [--size 3440x1440] [--no-audio] [--layers f,h,q] [--encoder auto|nvh264|va|va-lp|x264] [--vbv 250ms] [--av1 auto|on|off]
openlive-helper test-stream --loopback                      # no instance: publish to an in-process receiver
openlive-helper status                                      # build, encoders, paired instances
openlive-helper doctor [--encoder …] [--duration 5s] [--no-encode] [-v]   # system, desktop, GPU, GStreamer, encoder report + encode tests (for bug reports)
openlive-helper stream --room <roomId> --source monitor|window [--audio-app <name>|window] [--preset …] [--layers …]
openlive-helper stream --list-audio-apps                    # apps playing audio now
openlive-helper debug ping [--x 0.5] [--y 0.5] [--name Test] [--color olive] [--shape ring] [--count 4]   # draw a pointer ping on this desktop (no room)
```

`test-stream --loopback` runs the whole send path on one machine: GStreamer encoders → pion
(simulcast, rid/mid stamping, NACK, TWCC/GCC) → an in-process pion receiver that, like the SFU,
only tells the layers apart through the rid/mid header extensions. It sends a PLI on the top layer
every `--pli-every` and logs fps, bitrate and forced-IDR delay per layer every `--stats-every`.

`run` keeps an outbound WebSocket to the user hub (`/ws/hub`): no port is opened on
this machine, and the web's "Go live" screen lists the sources, starts, pauses, changes the preset
and stops streams through it, from any of the user's devices. The web lists the Linux backend's
"choose a screen" and "choose a window", which always show the system dialog (a window can send its
own app's audio), the last screen and window shared ("Last: <output or window title>", restored
by the portal without the dialog), and, with `--test-source` or in builds without the Linux
backend, the test pattern (with a colour-bar thumbnail). `--test-pattern ball` makes the Linux
backend capture a videotestsrc instead of the portal (development, no dialog), `--test-size
1913x1047` at a window's size instead of the preset's. `--test-image still.jpg` (on `run` and
`test-stream`, development) sends a still PNG or JPEG as the test source instead of the pattern,
named `--test-label` in the web; the README screenshots use it.

`--vbv` (20ms–2s, default 250ms) sets the encoders' fixed buffer for every stream `run` starts,
as on `test-stream` and `stream` (see "Encoders" for what it trades). The web's preset does not
carry a VBV: it is a property of this machine's encoder, not of the room.

Presets: `1080p30` (`text`), `1080p60` (`game`, default), `1440p60` (`max`),
`2160p60` (`native`), and the 120 fps ones (protocol 1.8, off until the platform
admin picks 120 fps): `1080p120` (`game120`, 14 Mbit/s) and `1440p120` (`max120`, 20 Mbit/s).
Layer `h` is 720p60 at 3.5 Mbit/s, `q` 480p30 at 1 Mbit/s, whatever the preset: only the top
layer runs at 120. Economy mode never keeps a 120 fps preset (it picks the best 60 fps one).

Tokens go to the system keyring (Secret Service on Linux). On a machine without one (CI, headless),
`--insecure-token-file` keeps them in `tokens.json` (mode 0600) in the config directory
(`$OPENLIVE_HELPER_CONFIG_DIR`, or `~/.config/openlive-helper`). The file store refuses a file
other users can read.

## Screen capture on Linux (`stream`)

`stream` is the CLI-only way to stream a real source until the web control (hub client) lands.
It also takes `--loopback`, `--preset`, `--layers`, `--encoder` and `--duration` like `test-stream`.

- **Portal.** The first run shows the desktop's own "Screen sharing" dialog (monitor or window,
  cursor embedded unless `--hide-cursor`). The portal's restore token rotates on every Start, so
  the helper saves the new one after **every** Start, with what was chosen (the output's name and
  geometry from KWin, or the window's app and title), in `screencast.json` (0600) in the config
  directory. A restored start (the web's "Last: …" sources, or `stream` without `--pick`) uses
  the token, so no dialog shows, and then **checks** what was restored against that choice:
  another output (the portal was seen silently restoring a different one) or a window of
  another app closes the session and shows the dialog again. The web's "choose a screen/window"
  and `--pick` never send the token, so the dialog always asks (with the token, KDE never showed
  the picker again after the first window).
  The log line `sharing` always says what is being shared.
- **Video path.** Two pipelines joined by `proxysink` → `proxysrc` (buffers, events and the
  allocation query cross natively; frames never pass through Go):
  - capture: `pipewiresrc` (`max-framerate` pinned, size free) → `proxysink`. Monitors read
    DMA-BUFs; windows read shared memory (with DMA-BUFs a window branch restarted after a resize
    got no frame on KWin 6.8).
  - encoder: `proxysrc` → leaky queue → `glupload` → `glcolorconvert` (the one GL consumer of
    KWin's buffers) → `glvideomixer` (scale and letterbox into the fixed output size) →
    `tee` → per layer `glcolorscale` → `cudaupload` → `nvh264enc` → appsink. The mixer's first
    input is a live black 16x16 source, so the encoders keep running at the output rate whatever
    the capture does, and a paused source or the curtain shows black.

  Layers keep their preset heights and take the source's aspect ratio (a 3440x1440 monitor at
  1080p60 is 2576x1080); the source is never upscaled. Widths are multiples of 16 (and so is a
  height below the preset's, a small window), so no frame is cropped on the right; the mixer
  letterboxes the few pixels this takes off the aspect ratio. The output size is fixed for the
  capture: a resized window is letterboxed into it, so the SPS never changes mid-stream. With x264 each layer goes through
  `gldownload`; without GL elements a CPU path (`compositor`, `videoscale`) is used
  (`--capture-path cpu`). Simulcast, PLI/FIR → IDR, live bitrate and the fixed VBV are the test
  backend's code.

  Why apart: in one pipeline, a `pipewiresrc` renegotiating a resized window blocked for ~9 s and
  took the mixer and every encoder with it. An appsink hand-off does not work either: go-gst
  frees a pulled sample only in a GC finalizer, which kept `pipewiresrc`'s 3 pool buffers and cut
  a 60 fps window to the 1 fps keepalive.

- **Restarts.** Only the capture pipeline is replaced; the encoder pipeline keeps running. A
  window resize restarts it as soon as KWin reports the new size (300 ms settle; the stream's
  own caps arrive seconds later); a size change in the caps also does; no frame for 10 s
  restarts it once, and a replacement that still delivers nothing ends the stream
  (`ErrSourceStalled`). Restarts are limited to 6 in 30 s; stopping a stuck capture pipeline is
  bounded at 3 s. The encoder pipeline and every capture pipeline share one clock and a base
  time the helper sets before starting them, and the first capture is added at once: the
  encoder pipeline only reaches PLAYING with the first capture frame (its appsinks wait for a
  preroll buffer, the mixer for its capture pad), so waiting for PLAYING first cost a 5 s
  timeout on every start and made the mixer catch up 5 s of frames, which is what ran the first
  capture at 24–30 fps (the "warm-up restart" of earlier versions is gone). The mixer's output
  starts at its first input's time (`start-time-selection=first`), so no backlog of black
  frames goes through the encoders at start.
- **Scaled outputs (HiDPI).** The portal reports a monitor's size in logical pixels, PipeWire
  delivers its real pixels. On a scaled output (KDE scale 2: 1920x1080 logical, 3840x2160
  pixels) the layers are fitted to the real pixels (KWin's output scale; without KWin a 1-frame
  probe reads the size), so 1440p60 and 2160p60 are no longer capped at the logical height;
  the mixer scales the capture down to the layers on the GPU.
- **Source ended.** A closed window (`target not found` from `pipewiresrc`) or a portal session
  closed from the desktop ends the stream normally: `stream.end`, then unpublish.
- **Paused.** KWin keeps sending a minimized window's frames, so the helper loads a small
  KWin script (D-Bus `org.kde.kwin.Scripting`) that calls the helper back with every window's
  state. The shared window is found by its frame size (`--window-hint` breaks ties between
  windows of one size); minimizing it sends `stream.update {paused: true, pauseReason:
source_hidden}` and shows black, restoring it resumes. `--still-pause <d>` adds the "content
  unchanged for N s" fallback (off by default), read from the top layer's encoded frame sizes,
  not from pixels. The **privacy curtain** is the same black frame with `privacy_curtain`,
  and the app audio is muted too: the PCM goes through a `volume` mute into an `audiomixer` that
  also takes a live silence source, so the Opus track keeps sending (encoded silence) and the
  capture is not forwarded; when the curtain lifts the audio is back at once. A hidden or still
  source pauses the video only. Linux and macOS behave the same: the curtain covers video and
  audio. In `stream`, `SIGUSR1` toggles it. Other compositors: no names, no
  window matching, no minimized pause (logged).
- **App audio**. `--audio-app <name>` captures one app: a capture node with
  `node.autoconnect=false`, linked only to that app's playback ports; links from anything else
  into it are removed, and new streams of the app are linked as they appear (checked every
  second). `--audio-app window` takes the shared window's process and its children (browsers
  play from a child process). When several windows of one app have the shared size (two browser
  windows), the window is unknown but the app is not: its audio is still captured and its name
  shown, only the minimized pause is off. It never uses GStreamer's PipeWire audio elements or a null sink.
  The audio is encoded in its own pipeline, so an audio failure never stops the video. An app
  that plays nothing gives no PCM, so the publisher sends Opus silence (20 ms frames) whenever
  60 ms pass without audio: the SFU refuses to subscribe a viewer to a track that never carried a
  packet (`empty_track_error`), which left viewers of a window shared with a silent app on
  "reconnecting".
  **Gap:** the design asks for libpipewire in-process. This version drives PipeWire through its
  own libpipewire clients, as experiments proved: `pw-record` (the capture node, raw PCM on a
  pipe), `pw-link` and `pw-dump`, behind the `audio.Capture` interface. The graph sees the same
  objects an in-process client would create. Replacing them with a cgo binding (or a small C
  shim) touches only `internal/audio/capture.go`. Kept on purpose after a second look: there is no
  maintained Go binding for libpipewire, and a cgo shim would run a `pw_thread_loop` with the
  registry, a `pw_stream` and link-factory proxies inside the helper process, the one place
  where a stall would reach the video (the design's own consequence); the child processes keep
  that failure apart, and the Flatpak runtime ships them too (`pw-record`, `pw-link`, `pw-dump`).
- **Voice sink**. Sharing a browser window with its audio would also capture the
  voice channel that browser plays. While `run` runs, the helper keeps a virtual speaker,
  "Openlive – voice" (`node.name=openlive-voice`, a `pw-loopback` child process), reports it in
  `helper.status.voiceSink`, and the web plays voice and its notice sounds into it. The sink plays
  on the default output, or on the speakers the web names (`helper.setVoiceOutput`, set as
  `target.object` with `pw-metadata`). App-audio capture never links a stream that plays into the
  sink, nor the sink's own output. Both nodes carry `openlive.voice-sink=true` and
  `openlive.helper-pid`; the process ends with the helper (`PR_SET_PDEATHSIG`), a check every 2 s
  starts it again after a PipeWire restart and ends leftovers of a helper that is gone, and a
  second helper instance uses the sink already there. `--no-voice-sink` turns it off (the web
  then warns a streamer who shares the browser they are in voice in). Check it on a real graph
  with `go test -tags integration -run TestVoiceSink -v ./internal/audio/` (quiet tones, on a
  second sink when there is one; it leaves nothing behind).

## Desktop: tray, shortcuts, notifications, autostart (`run`)

`run` lives in the system tray; the web stays the interface. Every part is
optional: where the desktop lacks one, the helper logs it once and keeps running headless, and the
web still controls it.

- **Tray** (StatusNotifierItem + DBusMenu over D-Bus). The icon is the app glyph: monochrome while
  idle (on KDE it follows the panel's text colour), red while live, amber while paused or under
  the curtain. The menu shows the state, the instance, and while streaming the room, the preset and
  the viewer count, then _Pause/Resume_, _Privacy curtain_ (a checkmark), _Stop stream_, _Open
  Openlive_ (the browser on the live room, else the instance), _Pair another instance…_ and _Quit_
  (stops a live stream first). The stream items run the same code as the web's commands, so the
  web sees `helper.status` and viewers see `stream.update` (pause reason `user` for _Pause_,
  `privacy_curtain` for the curtain; the web's own pause is the curtain). _Pair another instance_
  asks for the address in a `kdialog`/`zenity` box, shows the code in a notification and opens the
  browser; the new instance does not become the default (`run --instance <url>` uses it).
- **Global shortcuts** through the XDG GlobalShortcuts portal. Defaults: curtain
  `Ctrl+Alt+Shift+H`, pause/resume `Ctrl+Alt+Shift+P`, stop `Ctrl+Alt+Shift+X` (free in the common
  desktops, games, browsers and voice apps; three modifiers keep _stop_ from firing by accident).
  The first run on KDE shows a dialog to accept or change them; the desktop remembers the choice
  (System Settings → Shortcuts → Openlive helper), and later runs bind silently.
- **Global voice shortcuts** (since protocol 1.21) work while a game has the focus: push-to-talk
  (`talk`, `Ctrl+Alt+Shift+T`, hold it), mute (`mute`, `Ctrl+Alt+Shift+M`) and deafen (`deafen`,
  `Ctrl+Alt+Shift+D`). The helper reports them as `helper.voiceShortcut` and the web tab that is in
  voice applies them (docs/PROTOCOL.md section 8.5); push-to-talk only works when it is turned on
  in the voice settings. They need no stream. They are bound like the others (the portal's
  `Activated`/`Deactivated` give the press and the release; on macOS the Carbon pressed/released
  events); turn one off with `""` or `"off"`.
- **Notifications** (`org.freedesktop.Notifications`): you are live, stream stopped, your stream
  dropped, network unstable (the target bitrate held under half its peak, or ≥ 5% loss, for 10 s;
  at most once every 2 min), someone started watching (off by default), the curtain on/off, and
  "the helper is running" when started from a launcher (not with `--minimized`). The notice sounds
  (start, stop, alert, viewer) are short synthesized tones played with `pw-play`, `paplay` or
  `aplay`; the web has no sound files yet, so it can adopt these. Strings are English, or pt-BR
  when the system locale is Portuguese.
- **Restart after a crash** (Linux): `run` starts a copy of itself and starts it again after a
  crash (a fatal signal, or a Go panic after 10 s), after 1, 2, 5, 10 and 30 s. It gives up
  after 5 crashes in 10 minutes. Quit, Ctrl+C and logout end it. Set
  `OPENLIVE_HELPER_SUPERVISED=1` to run it in one process (debuggers). If driver crashes come
  back, the next step is the encoder in a child process.
- **Autostart**: `openlive-helper autostart enable` writes
  `~/.config/autostart/dev.hfps.OpenliveHelper.desktop` running `run --instance <paired> --minimized`
  (plus `--config-dir`/`--insecure-token-file` when given); `disable` removes it.
- **One `run` per instance**: a lock in `$XDG_RUNTIME_DIR/openlive-helper` makes a second one exit
  with "the helper is already running for <instance> (pid N)". Different instances can run side by
  side.

The portals only know apps by their `.desktop` file (KDE refuses a shortcut session without one),
so when no package installed `dev.hfps.OpenliveHelper.desktop`, `run` writes it, with the app icon,
to `~/.local/share/applications` and `~/.local/share/icons`.

The `desktop` block of `config.json` (all optional):

```json
{
  "desktop": {
    "tray": true,
    "language": "pt-BR",
    "shortcuts": {
      "curtain": "Ctrl+Alt+Shift+H",
      "pause": "",
      "stop": "Super+F12",
      "talk": "Ctrl+Alt+F9"
    },
    "notifications": { "enabled": true, "sounds": false, "viewerJoined": true, "unstable": true }
  }
}
```

`shortcuts`: modifiers `Ctrl`, `Alt`, `Shift`, `Super` (or `Meta`), then a letter, a digit,
`F1`–`F24` or an XKB key name (`Pause`, `Page_Down`); `""` or `"off"` turns one off. A typo turns
the shortcuts off with a log line rather than binding something unexpected. `notifications`:
`enabled` (all pop-ups), `sounds` (mute with `false`), and per event `started`, `stopped` (also
the drop), `unstable`, `viewerJoined`, `curtain`.

| Desktop                   | Tray                            | Shortcuts                                                        | Notifications |
| ------------------------- | ------------------------------- | ---------------------------------------------------------------- | ------------- |
| KDE Plasma 6 (tested 6.8) | yes                             | yes (a dialog the first time)                                    | yes           |
| GNOME 48+                 | with the AppIndicator extension | yes (GNOME's portal asks the first time)                         | yes           |
| GNOME before 48           | with the AppIndicator extension | no portal: none, logged                                          | yes           |
| Hyprland                  | with waybar's `tray` module     | `xdg-desktop-portal-hyprland` implements the portal (not tested) | mako, dunst   |
| Sway and other wlroots    | with waybar's `tray` module     | no portal: none, logged                                          | mako, dunst   |

## macOS (`stream`, `run`)

The helper starts the sidecar `openlive-capture` (`macos-capture/README.md`: pipeline, socket
protocol, signing) and turns its socket into a `Stream` (`internal/media/macos.go`); everything
after that (simulcast publish, PLI/FIR → IDR, the rate controller, the hub, the room) is the same
code as on Linux. The darwin build has no GStreamer: no cgo, and `test-stream` is unavailable
there (use `stream --test-pattern x`).

```sh
openlive-helper stream --list-sources                     # display:<id> and window:<id>
openlive-helper stream --list-audio-apps                  # running apps, for --audio-app
openlive-helper stream --room <id> --source monitor|display:<id>|window:<id> [--audio-app window|<name or bundle id>]
openlive-helper stream --loopback --test-pattern x --test-size 1600x900:150   # a moving test window, no instance
openlive-helper run [--test-pattern x]                    # the web lists every display and window, with thumbnails
openlive-helper doctor                                    # macOS version, Screen Recording, VideoToolbox, AV1
```

- **Sources.** Every display and every on-screen window is a source of its own (no system
  picker, unlike Wayland), with a thumbnail for the web's picker (macOS 14+). A window's own app
  audio can go with it (`--audio-app window`, the web's "with audio"); a display takes the app
  named with `--audio-app`. Only that app is captured, so a browser in an Openlive voice channel
  is left out unless it is the app shared, which shows the browser warning (the bundle id is reported as the binary: `com.google.Chrome`, `com.apple.Safari`…).
  There is no voice sink on macOS: the voice sink is PipeWire's.
- **Layers.** As on Linux: the preset's heights at the source's aspect ratio (a 3440x1440
  display at 1080p60 is 2576x1080, h 1728x720, q 1152x480), widths multiples of 16, never above
  the display's refresh rate. The sidecar encodes all three from one capture. A closed window
  ends the stream; a minimized or hidden one pauses it (`source_hidden`).
- **Encoder.** `vt` (VideoToolbox), the only one, so `--encoder auto` is `vt`. **No AV1:**
  VideoToolbox has no hardware AV1 encoder, so `--av1 auto` resolves to off (H.264 only, logged)
  and `--av1 on` fails; `doctor` says so.
- **Permissions.** Screen Recording only, for the app that starts the helper (`openlive-helper`
  itself under launchd, or the Terminal). Sign development builds (`MAC_SIGN_IDENTITY`,
  `macos-capture/README.md`) so it survives rebuilds. Without it, `stream` and the web's start
  fail with the steps to turn it on.
- **Desktop.** Tokens go to the macOS Keychain (`go-keyring`). `autostart enable` writes the
  LaunchAgent `~/Library/LaunchAgents/dev.hfps.OpenliveHelper.plist` (`run --minimized`, GUI
  session only, restarted after a crash, log in `~/Library/Logs/openlive-helper.log`). The rest
  of the desktop comes from the sidecar's **agent** (`openlive-capture agent`, started once by
  `run`; `internal/macagent`), with the Linux tray's states and actions:
  - **Menu bar item** (`NSStatusItem`, no Dock icon): an SF Symbol per state, idle, live (red),
    paused, curtain (an eye with a slash). The menu is the Linux tray's (`tray.Menu`): the state,
    the instance, and while streaming the room, the preset and the viewer count, then
    _Pause/Resume_, _Privacy curtain_ (a checkmark), _Stop stream_, _Open Openlive_, _Pair
    another instance…_ (the address in an AppleScript dialog) and _Quit_. `"tray": false` hides it.
  - **Notifications** through UserNotifications, under the app's own name, when the agent runs
    from the app (or the development bundle, `macos-capture/bundle.sh`, `OpenliveHelper.app` next
    to the helper) and the person allowed them; the first run shows macOS's prompt. Otherwise, or while
    the prompt waits, they go through `osascript` (as Script Editor's). The notice sounds play
    through `afplay`.
  - **Global shortcuts** as Carbon hot keys (`RegisterEventHotKey`), which need **no
    Accessibility permission**. Same config and defaults as Linux: curtain ⌃⌥⇧H, pause ⌃⌥⇧P,
    stop ⌃⌥⇧X (`Alt` is Option, `Super`/`Cmd` is Command; keys are the US-layout positions: a
    letter, a digit, F1–F20, arrows, `space`, `Return`, `Escape`…). A shortcut another app
    registered is a **conflict**: logged and shown in a notification, the others still bind.
    System shortcuts (Mission Control, Spotlight) cannot be detected and win.
  - **Privacy curtain** as on Linux: every layer encodes a **black frame** instead of the screen
    and the app audio is encoded as **silence**, so the encoders, the tracks and the viewers stay
    connected; the room shows `privacy_curtain`, thumbnails stop, and when it lifts every layer
    sends a key frame (`gatedStream`), so viewers see the screen again at once. `SIGUSR1` toggles
    it in `stream`.

**Measured** (M4 Pro, macOS 26.3, a 3440x1440 175 Hz display, a moving test
window with 1000 particles/s; `openlive-capture bench`, 15 s, a forced IDR every second on every
layer; the full tables are in the pull request that added it):

| Preset (layers f/h/q)                   | f fps | h, q fps   | f encode p50/p95 | forced IDR p50/p95 (f) | sidecar CPU    |
| --------------------------------------- | ----- | ---------- | ---------------- | ---------------------- | -------------- |
| 1080p60 (2576x1080, 1728x720, 1152x480) | 60.0  | 60.0, 30.0 | 13.3/16.3 ms     | 18.7/20.0 ms           | 24 % of a core |
| 1440p60 (3440x1440, …)                  | 60.0  | 60.0, 30.0 | 12.9/14.6 ms     | 20.8/23.8 ms           | 21 %           |
| 1080p120 (2576x1080@120, …)             | 115.3 | 60.0, 30.0 | 22.1/26.5 ms     | 27.3/30.3 ms           | 28 %           |
| 1440p120 (3440x1440@120, …)             | 74.4  | 60.0, 30.0 | 13.1/14.7 ms     | 44.6/50.5 ms           | 22 %           |

Capture delay (display time → frame in the sidecar) is under 1 ms. A low-latency VideoToolbox
session encodes one frame at a time, so 3440x1440 tops out near 75–85 fps: 1440p120 on an
ultrawide display is beyond the M4 Pro (1080p120 alone holds 119.8). **Low-latency rate control
drops frames** instead of raising the QP when the content needs more bits than the target (4000
particles/s at 8 Mbit/s: 30 fps out of 60; the same at 16 Mbit/s: 60): under a deep bitrate cut
the stream loses frame rate before it blocks up. Without it (`--llrc off` in the bench) nothing
is dropped, but the bitrate overshoots by ~40 % and each frame waits ~30 ms in the encoder.

**Install (the app).** Releases are **Openlive Helper.app**, universal, signed with a Developer
ID, notarized, in `openlive-helper-<version>-macos.dmg`, which members download from
the instance's `/download`:

1. Open the disk image and drag **Openlive Helper** onto Applications.
2. Open it from Applications (the first time, macOS asks to confirm opening an app downloaded
   from the internet: **Open**). It then asks for the instance address and opens the
   browser to confirm the pairing code.
3. Allow **Screen Recording** when macOS asks (System Settings > Privacy & Security > Screen &
   System Audio Recording).
4. The helper is now in the menu bar and starts at every login (a LaunchAgent, as `autostart
enable` writes, pointing at the app). In a room, **Go live**.

The commands above work from the app too:
`"/Applications/Openlive Helper.app/Contents/MacOS/openlive-helper" doctor`. Building, signing and
notarizing a release, and what the app does when opened: `packaging/macos/README.md`. Screen
Recording granted to a development build does not carry over to the app (another code identity).

## Pointer pings (PROTOCOL.md §7.9)

When the streamer allows it, a viewer who clicks the video makes a pulsing marker with their name
appear for about 2 s at that point of the streamer's screen, in the viewer's color and shape
(ring, dot, crosshair, star). Nothing is injected: the marker takes no input, so clicks go to what
is under it, and it never takes the keyboard.

- **Drawing** (`internal/overlay`): the helper's own small Wayland client, pure Go,
  drawing in shared memory with `golang.org/x/image`; no Qt or GTK, so the tarball and the
  Flatpak need nothing more than the Wayland socket. Each ping is a small surface on the layer
  shell's overlay layer (above fullscreen windows, with an empty input region), created when the
  ping arrives and destroyed when it ends: between pings nothing is mapped and nothing ticks.
  HiDPI: drawn at the output's exact scale through `wp_viewporter`.
- **Mapping**: `x` and `y` (0 to 1 over the video) skip the letterbox, then land on the shared
  monitor's logical geometry, or on the shared window's current geometry from the KWin script
  (it follows the window when it moves), on whichever monitor holds the point. Pings off every
  monitor, on the black bars, on a minimized window, or while the curtain or a pause is on are
  dropped.
- **Announcing**: `stream.announce` says `pingOverlay: true` only on a Wayland session whose
  compositor has the wlr layer shell and with a capture KWin can place (KDE Plasma 6). X11, GNOME,
  wlroots desktops (no KWin) and macOS say false, so the web never offers pings there. The
  overlay connects while `StreamInfo.pings` is on and disconnects when the streamer turns it off.
- `doctor` prints `pings: overlay yes|no (… layer-shell yes|no …)`. `debug ping` draws pings on
  a monitor without a room (`--count 4` shows several at once, in every color and shape); `go
test -tags integration ./internal/overlay/` draws one and checks the click-through.

## Layout

| Package               | What                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd/openlive-helper` | CLI.                                                                                                                                                                                                                                                                            |
| `internal/media`      | `MediaBackend` / `Stream` (§9.3), presets, the GStreamer test backend (go-gst), the Linux screen backend, the macOS backend (the sidecar's process and socket), encoder choice (NVENC → VA-API → x264; VideoToolbox on macOS), PLI/FIR → IDR limiter (rate-limited, coalesced). |
| `internal/sidecar`    | The macOS sidecar's wire format (length-prefixed messages), mirrored by `macos-capture/Sources/CaptureProtocol`.                                                                                                                                                                |
| `macos-capture/`      | The Swift sidecar: ScreenCaptureKit capture, VideoToolbox encode, Opus, the bench (`macos-capture/README.md`).                                                                                                                                                                  |
| `internal/portal`     | xdg-desktop-portal ScreenCast sessions, the rotating restore token and the chosen source (`screencast.json`), the restored-source check.                                                                                                                                        |
| `internal/compositor` | KWin queries through a scripting callback: outputs by name, windows and their minimized state, matching a stream to its output or window.                                                                                                                                       |
| `internal/overlay`    | Viewers' pointer pings on the streamer's screen: a minimal pure-Go Wayland client (layer shell, `wl_shm`), the animation and drawing, mapping a ping to the shared output or window.                                                                                            |
| `internal/audio`      | PipeWire graph model (`pw-dump`), per-app selection, the link plan, the `pw-record`/`pw-link` capture, the voice sink (`pw-loopback`).                                                                                                                                          |
| `internal/rtc`        | pion publisher: one simulcast track (one encoding per layer), the AV1 top-layer track + Opus, the rid/mid stamper, GCC → encoder bitrate with hysteresis and a loss watchdog (§8.4), the `Signaler` interface, the loopback.                                                    |
| `internal/api`        | REST client (pairing, `/api/rtc/*` signaling) and the room WebSocket client, on the generated types in `packages/protocol/go`.                                                                                                                                                  |
| `internal/tray`       | StatusNotifierItem and DBusMenu, the menu state machine, the icons drawn from the app glyph.                                                                                                                                                                                    |
| `internal/hotkeys`    | Shortcut config parsing, the GlobalShortcuts portal session, and the triggers as macOS key codes.                                                                                                                                                                               |
| `internal/macagent`   | The macOS desktop agent (`openlive-capture agent`): menu bar item, UserNotifications and Carbon shortcuts over the sidecar protocol.                                                                                                                                            |
| `internal/notify`     | Notification policy, the notice sounds, the network-unstable watch, the D-Bus notifier.                                                                                                                                                                                         |
| `internal/autostart`  | The XDG autostart entry and the application entry the portals need.                                                                                                                                                                                                             |
| `internal/single`     | The one-`run`-per-instance lock.                                                                                                                                                                                                                                                |
| `internal/i18n`       | Desktop strings, English and pt-BR.                                                                                                                                                                                                                                             |
| `internal/store`      | Keyring and file token stores, the config file (with its `desktop` block).                                                                                                                                                                                                      |

`Stream.SetBitrate` and `Stream.RequestKeyframe` take the layer's RID, unlike the §9.3 sketch:
each layer has its own encoder, and a PLI/FIR arrives for one layer's SSRC.

Encoder rules: CBR, no B-frames, low-latency tuning, a
**fixed VBV** (250 ms at the start bitrate by default, `--vbv`; only the bitrate changes live), a **long fallback GOP**
(10 s), and every PLI/FIR forces an IDR, at most one per 250 ms per layer with requests inside the
window merged into one IDR at its end. x264 runs with sliced threads: with frame threads (as in the
first experiments) a forced IDR took ~390 ms to come out on a 16-thread CPU, with slices ~18 ms.

Rate control: the GCC estimate × 0.85 headroom is the total; it goes down at once when 10% lower,
and up only after 2 s above, by at most 25% per step. The **watchdog** caps the
target at 75% when receiver reports show ≥ 5% loss for 2 s while the estimate moves by less than
5%; the cap relaxes by 25% every 2 s once loss is under 2%. The total is split over the layers
lowest first (each gets its minimum, then `q`, `h`, `f` up to their targets), so the top layer
absorbs a cut. A preset change while live (`helper.setPreset`) gives the controller the new
layers' budget (`Publisher.SetLayers`): their minimums and targets, the room's cap fitted to
them, and a start no higher than the last estimate allows; before, the controller kept the old
preset's sums, so 1080p30 → 1440p60 stayed capped at 10.5 Mbit/s with `f` at 6 Mbit/s, and
1440p60 → 1080p30 could set the 1080p30 encoder to 12 Mbit/s. The bandwidth estimate's own
ceiling is set at the start for the largest preset the room allows, since it cannot change.

**Keyframe requests** are counted per layer and per RTCP sender (`PLIs`, `FIRs`,
`Requesters` in the stats; a sender's first request is logged at info, the rest at debug with
its running count, and the stats line shows `keyframeRequests`/`requesters`). A PLI loop shows
as one requester with a growing count, which is how the re-pull loop fixed in #38 looked from
the helper. The IDR's size is bounded by the VBV: on noise at 8 Mbit/s an IDR was 176–202 KB
with 250 ms and ~70 KB with 125 ms (direct NVENC test). `--vbv 125ms` (or less) on `stream` and
`test-stream` trades some quality for smaller IDR bursts on weak links; `nvh264enc` has no
intra-refresh option in GStreamer and `qp-min-i` barely changed the IDR size (196/147/179 KB at
34 vs 202/180/176 KB). The default stays 250 ms: the iPhone loop of #35 was the viewer's
re-pull (#38), not the IDR size.

## 120 fps

- **Capture rate.** The capture asks KWin for the preset's rate (`max-framerate`). A monitor slower
  than the preset (read from `kscreen-doctor -j`: KWin's scripting API has no refresh rate) caps
  every layer at its rate, with a warning (`the monitor refreshes slower than the preset`): a 120
  fps preset on a 60 Hz monitor encodes 60 fps instead of repeated frames. A window takes its
  output's rate. Without KScreen (another desktop, the Flatpak sandbox) the preset's rate stands.
  A static screen still makes KWin send fewer frames than the rate: measure with motion.
- **Encoder settings per fps** (`settingsFor`): the fallback GOP is time, so its frames double at
  120 fps (1,200 for 10 s); VA-API's `key-int-max` stops at 1,024, so it is capped there (8.5 s).
  The VBV stays time (250 ms), so at 120 fps it holds twice the frames and an IDR stays the same
  share of a second; at 20 Mbit/s it is 5,000 kbit.
- **H.264 level.** The encoders set each layer's SPS level themselves (NVENC: 1440p120 → 5.2,
  checked by `doctor`). The SDP's `profile-level-id` was pion's 42e01f (3.1) for every stream; it
  now announces the highest level the layers need (`media.SDPLevel`, H.264 Table A-1, never below
  3.1), because one payload type carries every simulcast layer: 1080p60 → 4.2, 1440p60 and
  1080p120 → 5.1, 1440p120 → 5.2, an ultrawide 3440x1440 at 120 → 6.0. The 4.2 and
  5.1 first planned for the 120 fps presets are one level short each: 4.2 stops at 1080p64, 5.1 at 1440p68.
- **Rate control** needs no new constants: the controller, the watchdog and the bandwidth
  estimate's ceiling are all relative to the layers' targets and the room's cap, and the ceiling
  is 1.5× the largest preset the room allows (36.75 Mbit/s with `max120`).
- **`doctor --preset 1440p120`** (or `1080p120`) runs the encode test at 120 fps on every encoder:
  it says whether each one holds the rate (≥ 95 %) and compares the SPS level with the layer's.
  It also lists the monitors and their refresh rates. On the development machine (RTX 4080):
  NVENC 120.2 fps, level 5.2; x264 80 fps (does not hold it).

## AV1

A stream can also publish its **top layer in AV1** on a second track, `<prefix>-video-av1`
(protocol 1.14): the same size and frame rate as `f`, no simulcast, at 65 % of its bitrate to
save data or at 100 % for a sharper picture, as the platform admin chose for the preset ("AV1:
save data" or "AV1: quality": `RoomSettings.av1QualityPresets`, protocol 1.17).
Viewers whose browser decodes AV1 pull it on the top layer; every other layer, and every other
viewer, stays on the H.264 simulcast track.

- **When.** `--av1 auto` (the default, on `run`, `test-stream` and `stream`) publishes it when the
  room's `RoomSettings.av1Presets` has the stream's preset (the platform admin's "Allow AV1", off
  by default) and the H.264 encoder's family has an AV1 encoder: NVENC → `nvav1enc` (RTX 40 and
  newer), VA-API → `vaav1enc`, `va-lp` → `vaav1lpenc` (implemented, untested on real hardware).
  x264 has none. `--av1 on` publishes it whatever the room says (measurements), `off` never. The
  choice is made at the start; a preset change keeps the tracks.
- **Encoder.** The same rules as H.264 (CBR, ultra-low-latency, no B-frames, fixed VBV, 10 s
  fallback GOP, a key frame on PLI/FIR, live bitrate). `av1parse` frames one temporal unit per
  buffer (OBUs with size fields), which pion's AV1 payloader reads; NVENC repeats the sequence
  header before every key frame. Inside the helper the AV1 layer is `af` (encoder `enc_af`, appsink
  `sink_af`, stats and logs); on the wire the track has no rids.
- **Rate control.** The GCC total is split between the tracks in proportion to their targets
  (~12.5 + 5.2 Mbit/s at 1080p60), so a cut lowers both top layers. The room's `maxBitrateKbps`
  is the H.264 track's (the publish's `maxBitrateKbps`), the AV1 track gets the same share of its
  target on top.
- **Why the top layer only.** The Realtime SFU does not negotiate the AV1 Dependency Descriptor and
  never switched layers inside an AV1 simulcast track (it sent a FIR every second and kept the old
  layer); one AV1 track per layer would need 5 tracks, one more than `tracks/new` takes. See the
  ADR for the measurements.
- `doctor` lists `nvav1enc`, `vaav1enc`, `vaav1lpenc` and `av1parse`, and after each H.264 encode
  test runs its family's AV1 encoder on the same layer: fps, bitrate, forced key frame, key frames
  after a bitrate change, and key frames without a sequence header. On the RTX 4080: 60 fps, a
  forced key frame in 11–18 ms, none after a bitrate change, a sequence header on every key frame;
  on pure noise (`snow`) NVENC AV1 sits at its highest quantizer (~16.5 Mbit/s at 1080p60 whatever
  the target), on `--pattern smpte` it holds the target.
- `test-stream --loopback --av1 on` runs both tracks to the in-process receiver (its PLIs hit the
  top layer of each track); `helper/e2e/viewer.mjs` takes `CODEC=av1` and `EXPECT_CODEC=video/AV1`.

## Encoders

Auto picks the first one GStreamer has: **NVENC** (`nvh264enc`, NVIDIA), **VA-API**
(`vah264enc`, or `vah264lpenc` where only Intel's low-power entrypoint exists; AMD and Intel
through Mesa or intel-media-driver), then **x264** (CPU, the last resort; an
experiment measured that the CPU path does not hold 1080p60). `--encoder` forces one; `status` and `doctor` show what was found.

- Where they live: `internal/media/encoder.go` (choice: `ResolveEncoder`, `DetectEncoders`;
  settings: `encoderElement`), `internal/media/linux.go` (`linuxPipelineDescription`: how frames
  reach each encoder) and `internal/media/pipeline.go` (the test backend's pipeline).
  `gststream_gst.go` changes the bitrate live and forces IDRs. Its `Stop` drains every encoder
  (EOS) before the pipeline goes to NULL: destroying an NVENC session with frames in flight made
  the driver's completion thread read freed memory, a SIGSEGV in `libnvcuvid` seconds after a
  preset change.
- The per-layer branch after the GL mixer: NVENC `[glcolorscale] → cudaupload → nvh264enc`;
  VA-API `[glcolorscale] → gldownload → vapostproc → VAMemory NV12 → vah264enc` (gldownload
  exports a DMA-BUF and vapostproc imports it, so frames stay on the GPU where the driver allows
  it); x264 `gldownload → videoconvert → x264enc`.
- Rules for every encoder: CBR, no B-frames, constrained baseline (what pion's fmtp
  signals and iOS plays), a long GOP, an IDR on `force-key-unit`, live `bitrate` changes, a fixed
  VBV. **VA-API caveat:** `vah264enc` applies a new bitrate by draining and resetting its GOP, so
  every change is an IDR (gst-plugins-bad 1.28 `sys/va`); the helper spaces VA bitrate changes 3 s
  apart (`bitrateGate`) and only the latest is applied.
- **Status of VA-API: implemented, untested on AMD/Intel hardware** (the development machine has
  an NVIDIA card). Pipelines, selection and the element settings are unit-tested.
- Adding or tuning one: add the `Encoder` value and its element to `encoderElements`, its
  settings to `encoderElement`, its branch to `linuxPipelineDescription`, then the cases in
  `TestResolveEncoder`, `TestVAEncoderElement`-style and `TestLinuxPipelineDescription`. Run
  `go test ./internal/media/`, the integration test below, and `openlive-helper doctor`.
- **`openlive-helper doctor`** prints the system, GPUs and drivers (`vainfo` when installed),
  GStreamer's version and elements, the encoder auto picks and why, and runs a short encode on
  each available encoder through the real Linux encoder pipeline (a test pattern in place of the
  portal): fps, bitrate, the forced IDR's delay and size, IDRs a bitrate change caused, and
  errors. It reads no configuration or token, so its output can be pasted into a bug report.
- **Black test patterns (NVIDIA, Wayland EGL).** On the development machine (NVIDIA 615.78,
  GStreamer 1.28.8) a `videotestsrc` frame uploaded with `glupload` under Wayland EGL came out
  black, and correct with `GST_GL_WINDOW=x11`. Real captures are not affected (measured: a
  monitor over DMA-BUF, and a window over shared memory at ~7 Mbit/s with and without the
  variable), so this only touches `--test-pattern`, the integration test's picture and `doctor`'s
  bitrate. `doctor` warns when its snow IDR is too small to be real content; run it with
  `GST_GL_WINDOW=x11` for meaningful bitrates and IDR sizes.

## Desktop compatibility

`openlive-helper doctor` starts with a **Desktop** section that answers this table for the machine
it runs on: `XDG_CURRENT_DESKTOP` and the session type, the xdg-desktop-portal backend that
implements ScreenCast (from the installed `*.portal` files and `*-portals.conf`, as
xdg-desktop-portal 1.18+ picks it), the ScreenCast portal's version with its source types, cursor
modes and whether it can restore a share without the dialog (version 4+), whether the
GlobalShortcuts portal and a StatusNotifier host are present, and KWin's version and scripting
interface. It also checks GStreamer against the minimum, **1.22**: the first with the va
plugin's `vah264enc`/`vah264lpenc` and the CUDA-memory `nvh264enc` (with `cudaupload`) that
changes bitrate while playing. Below it, or when the distribution lacks those plugins, use the
**Flatpak**, whose runtime brings its own GStreamer.

| Desktop                             | Status       | Screen / window capture                                   | Restore without the dialog | Paused when the window is minimized; output names | Tray                   | Global shortcuts                    |
| ----------------------------------- | ------------ | --------------------------------------------------------- | -------------------------- | ------------------------------------------------- | ---------------------- | ----------------------------------- |
| KDE Plasma 6 (Wayland)              | **Tested**   | yes (`xdg-desktop-portal-kde`)                            | yes                        | yes (KWin script)                                 | yes                    | yes                                 |
| GNOME 46+ / Ubuntu 24.04+ (Wayland) | Expected     | yes (`xdg-desktop-portal-gnome`)                          | yes (ScreenCast v4+)       | no (KWin only): streams as is                     | AppIndicator extension | GNOME 48+ only                      |
| Hyprland                            | Expected     | yes (`xdg-desktop-portal-hyprland`)                       | backend-dependent          | no                                                | waybar `tray`          | yes (`xdg-desktop-portal-hyprland`) |
| Sway and other wlroots              | Expected     | monitors (`xdg-desktop-portal-wlr` has no window capture) | backend-dependent          | no                                                | waybar `tray`          | no portal: off, logged              |
| X11 sessions                        | Not targeted | through the portal where the backend offers it            | backend-dependent          | not tested                                        | as the desktop         | as the desktop                      |

"Expected" means the helper only uses the standard portals there and its tests pass, but nobody
has streamed from that desktop yet: a `doctor` report from one is the most useful bug report.
Per-app audio needs PipeWire (with `pw-link`) on every desktop.

## Install on Linux

- **Tarball** (`openlive-helper-<version>-linux-amd64.tar.gz` on the release): `./install.sh`
  puts the binary, the menu entry and the icons in `~/.local`. GStreamer comes from the
  distribution: on Arch `gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad
gst-plugin-pipewire gst-plugin-va gst-plugins-ugly pipewire`; on Fedora/Ubuntu the matching
  `gstreamer1-plugins-*` / `gstreamer1.0-plugins-*` packages plus `gstreamer1.0-pipewire`. NVENC
  needs the NVIDIA driver (nvcodec is in gst-plugins-bad). **Recommended for NVIDIA.**
- **Flatpak** (`openlive-helper-<version>.flatpak`): `flatpak install --user
openlive-helper-<version>.flatpak`. It runs on org.freedesktop.Platform 26.08, which ships
  GStreamer with nvcodec, va and x264; see `packaging/linux/README.md` for what works in the
  sandbox.
- `openlive-helper pair --instance https://your-instance`, then start "Openlive Helper" from the
  menu (it runs `openlive-helper run`).

## Build tags and CI

`internal/media` links GStreamer through cgo (go-gst), which needs the GStreamer development files
(`gstreamer-1.0`, `gstreamer-app-1.0`, `gstreamer-video-1.0` via pkg-config) at build time and
gst-plugins-base/good/bad (nvcodec for NVENC, va for VA-API), gst-plugins-ugly for x264 and
gst-plugin-pipewire at run time. Release builds: `packaging/linux/build-tarball.sh` (run in the Flatpak SDK by `build-tarball-in-sdk.sh`) and the
Flatpak manifest in `packaging/linux/` (`packaging/linux/README.md`); the `release-helper`
workflow runs both on a `helper-v*` tag and uploads to a draft release.

- Default build: with GStreamer. On Linux this includes the screen backend.
- `-tags nogst`: no cgo dependency. The test backend becomes a stub that returns
  `media.ErrUnavailable`, and the GStreamer integration test is not compiled. Everything else
  (rtc, api, store, the CLI) is the same.
- darwin: never GStreamer (as with `nogst`); the screen backend is the sidecar. Build the
  sidecar on a Mac with `swift build -c release` (`macos-capture/README.md`).

CI (GitHub runners have no GStreamer) runs `go vet`, `go test` and `golangci-lint` here with
`GOFLAGS=-tags=nogst CGO_ENABLED=0`, and `go vet` plus `golangci-lint` cross-compiled for
darwin/arm64. The macOS backend's tests run on Linux against a fake sidecar (the test binary
plays `openlive-capture`'s side of the protocol); the Swift tests (`swift test` in
`macos-capture/`) need a Mac. Locally:

```sh
go vet ./... && go test ./... && golangci-lint run      # with GStreamer, runs the 2 s pipeline test
go test -short ./...                                     # skips the pipeline test
GOFLAGS=-tags=nogst CGO_ENABLED=0 go test ./...          # what CI runs
go test -tags integration ./internal/media/ ./internal/compositor/ ./internal/audio/ ./internal/tray/ ./internal/hotkeys/
```

The `integration` tag adds tests that need this desktop and are never run in CI: the Linux
pipeline on a GL test pattern (start time, fps per layer from the first second, a source restart
at a new size, the curtain), 12 live preset changes on NVENC, where
`MALLOC_MMAP_THRESHOLD_=65536` makes a use-after-free crash at once, the KWin watch script, the tray over the session bus (menu layout, a click, the icon change), the GlobalShortcuts binding (`OPENLIVE_PRESS=1` waits for a real key press), and a real per-app capture linked to the first app playing audio (it checks
that nothing else is linked in). The portal itself needs a person at the dialog; see the pull request that
added it for the measured run. `stream --test-pattern mandelbrot` runs the whole Linux path without a
portal.

## Contract with the server

The helper speaks protocol 1.2 with the generated types in `packages/protocol/go`
(docs/PROTOCOL.md §4, §7.2, §8, §11.1–11.2); `internal/api/routes.go` lists the routes.

- **Pairing** (`pair`): `POST /api/devices/code`, open `verificationUriComplete`, then poll
  `POST /api/devices/token` every `intervalMs`. `authorization_pending` keeps polling, `slow_down`
  switches to its `intervalMs` (or adds 5 s), `rate_limited` waits `retryAfterMs`, and
  `expired_token` (or `expiresInMs` running out) stops. The `deviceToken` goes to the keyring.
- **Publishing** (`test-stream --room`): `GET /api/rooms/:id` for the room's allowed presets and
  `maxBitrateKbps` (a too-high total is capped there: the encoders start at the cap, the top layer
  absorbs the cut), `POST .../ice`, `POST .../publish` with the preset and `maxBitrateKbps`, then
  the room socket (`hello` with the device's `deviceId`) and `stream.announce` within
  `announceWithinMs`. On the way out: `stream.end`, then `POST .../unpublish`. The socket opens
  after the publish on purpose: a second `test-stream` on the same device gets `helper_busy` from
  the publish instead of replacing (4002) the running one's socket.
- **While live:** `stream.stop` and `stream.ended` for its stream end the run. If the socket drops
  abnormally, the helper says `hello` again with the same `deviceId` within the room's 15 s grace
  and keeps the stream when the welcome still lists it. Close codes 4001–4006 are final.
- **Hub** (`run`): `hello` on `/ws/hub` with the device's `deviceId`, then `helper.status` after the
  welcome and on every change. Commands arrive with the hub's ids and get their reply under the same
  id: `helper.listSources` → `helper.sources` (then one `helper.sourceThumbnail` per source when
  asked), `helper.startStream` → `ack` once announced in the room, or the error code from the
  publish path (`helper_busy` while live, `source_not_found`, `quota_exhausted`, …),
  `helper.pauseStream` (privacy curtain: no frames leave the helper, `stream.update` with
  `privacy_curtain`), `helper.setPreset` (a new capture is swapped in under the same publication),
  `helper.stopStream`, `helper.setVoiceOutput` (the voice sink's speakers; always `ack`).
  `helper.status` carries `voiceSink` while the sink exists and, while live with app audio,
  `stream.audioApp`. `helper.stats` goes out every second while live. The hub socket reconnects
  with backoff (1 s → 30 s) and a live stream does not depend on it; 4001, 4002 and 4006 end `run`.
- **Errors** are codes; the CLI explains the ones a streamer can hit (`quota_exhausted`,
  `stream_permission_required`, `preset_not_allowed`, `bitrate_not_allowed {limit}`,
  `stream_limit_reached`, `helper_busy`, `rtc_not_configured`, `sfu_error`, revoked tokens and
  the final close codes) in `cmd/openlive-helper/errors.go`.

## Local end-to-end loop

Helper → Worker → Realtime SFU → a headless Chrome viewer, on one machine. It uses the **dev**
Realtime app, local D1 and `wrangler dev`; nothing is deployed.

```sh
# 1. API on :8790 with the dev Realtime credentials and the dev identity.
cp .dev.vars apps/api/.dev.vars                  # repo root → apps/api; both git-ignored. Never print it.
printf 'DEV_AUTH=1\nSESSION_SECRET=%s\n' "$(openssl rand -base64 32)" >> apps/api/.dev.vars
pnpm --filter @openlive/api db:migrate:local
pnpm --filter @openlive/api dev                  # wrangler dev --port 8790

# 2. A user, a space and a room. DEV_AUTH trusts X-Openlive-Dev-User from localhost only.
(cd apps/api && npx wrangler d1 execute DB --local --command \
  "INSERT INTO users (id, display_name, created_at) VALUES ('u_dev', 'Dev', $(date +%s000))")
H='X-Openlive-Dev-User: u_dev'; B=http://localhost:8790
curl -s -X POST $B/api/spaces -H "$H" -H "Origin: $B" -H 'Content-Type: application/json' -d '{"name":"Dev","slug":"dev"}'
curl -s -X POST $B/api/spaces/<spaceId>/rooms -H "$H" -H "Origin: $B" -H 'Content-Type: application/json' \
  -d '{"name":"Helper","slug":"helper"}'

# 3. Pair. Approve the printed code on /link (Vite on :5179) or as the dev user:
go build -o /tmp/olh ./helper/cmd/openlive-helper
/tmp/olh pair --instance $B --config-dir /tmp/olh-cfg --insecure-token-file --no-browser &
curl -s -X POST $B/api/devices/approve -H "$H" -H "Origin: $B" -H 'Content-Type: application/json' \
  -d '{"userCode":"<code>","name":"dev-helper"}'

# 4. Stream, and watch it through the real proxy routes.
/tmp/olh test-stream --instance $B --config-dir /tmp/olh-cfg --insecure-token-file --room <roomId> --duration 60s &
npm install --prefix /tmp/pw playwright-core     # any recent version; it drives the installed Chrome
INSTANCE=$B ROOM=<roomId> DEV_USER=u_dev PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core \
  CHROME=/usr/bin/google-chrome-stable node helper/e2e/viewer.mjs
```

`helper/e2e/viewer.mjs` runs the web player's sequence: `POST .../ice`, `POST .../session` with a
data-channel offer (DTLS connects before any click), `slot.request` on the room socket,
`POST .../subscribe`, the answer through `PUT .../renegotiate`, then `PUT .../layer` to `h`, `q`
and back to `f`. For each layer it prints the decoded resolution, fps (from `framesDecoded`) and
bitrate, and how long each switch took to reach the decoder; it fails if `framesDecoded` stops
growing. It releases the slot and calls `POST /api/rtc/leave` at the end. The layer sizes it
expects are the ones the helper announced (`StreamInfo.layers`, protocol 1.19): with
`test-stream --preset native --size 3440x1440` the test pattern is fitted like a 3440x1440 monitor
(f 3440x1440, h 1728x720, q 1152x480), which is how to check a non-16:9 source end to end.

**Pulling again** (`apps/web/e2e/repull-pli.mjs`): with two `test-stream -v` in the room (one per
streamer, each paired as its own helper), the script opens and closes the player five times,
switches to the other stream and back, then watches for 60 s and counts the keyframe requests
each helper logged, the PLIs Chrome sent and the live video receivers on the session. It fails
unless one receiver is live and the helpers got at most `MAX_PLIS` (2) requests in the window.

```sh
ROOM_PATH=/s/dev/r/helper VIEWER=u_view HELPER_LOGS=/tmp/ts-a.log,/tmp/ts-b.log \
  PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core node apps/web/e2e/repull-pli.mjs
```

**Go live from the web** (`apps/web/e2e/go-live.mjs`): instead of step 4, keep the helper running
with `/tmp/olh run --instance $B --config-dir /tmp/olh-cfg --insecure-token-file --test-source`, start the web
(`pnpm --filter @openlive/web dev`, Vite on :5179) and add a second user to the space as a viewer.
The script goes live from the Room page (helper → source with its thumbnail → Start), checks the
streamer's stats, plays the stream in a second browser context, pauses and resumes (privacy
curtain), changes the preset while live, and stops; the viewer sees the curtain and the ended
screen.

```sh
ROOM_PATH=/s/dev/r/helper STREAMER=u_dev VIEWER=u_view \
  PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
  node apps/web/e2e/go-live.mjs
```
