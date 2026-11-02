# Linux packaging of the helper

Two release artifacts, both built by the
`release-helper` workflow on a `helper-v<version>` tag and attached to a **draft** release, with a
`SHA256SUMS` over the release's files ([../RELEASING.md](../RELEASING.md)):

| Artifact                                       | What                                                                                                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openlive-helper-<version>-linux-amd64.tar.gz` | The binary (cgo, GStreamer and GLib linked dynamically, version stamped with `-X main.version`), the desktop entry, the AppStream metainfo, the icons, `install.sh` (into `~/.local`) and `THIRD_PARTY_NOTICES`. Uses the system's GStreamer. |
| `openlive-helper-<version>.flatpak`            | A Flatpak bundle on `org.freedesktop.Platform//26.08`, which ships GStreamer 1.28 with nvcodec, va, x264, pipewiresrc, the GL elements and the PipeWire tools.                                                                                |

The application id is `dev.hfps.OpenliveHelper`, the name the helper gives the portals and the
notifications (`run` writes a user-level entry under it when no package installed one).

## Files

- `dev.hfps.OpenliveHelper.desktop`, `.metainfo.xml`, `icons/dev.hfps.OpenliveHelper.svg` (the
  hfps app icon from `docs/img/icon.svg`).
- `build-tarball.sh`: `VERSION=0.1.0 packaging/linux/build-tarball.sh` → `dist/`. Needs Go, a C
  compiler, the GStreamer development files (`gstreamer-1.0`, `gstreamer-video-1.0`,
  `gstreamer-app-1.0`) and `rsvg-convert` or ImageMagick.
- `build-tarball-in-sdk.sh`: the same, run inside `org.freedesktop.Sdk` (the manifest's runtime
  version, GStreamer 1.28) with the Go toolchain the manifest pins, downloaded into `build/` and
  checked against its sha256. The release workflow uses it: Ubuntu 24.04's GStreamer 1.24 is too
  old for go-gst. The binary needs glibc 2.34 or newer and GStreamer from the system at run time.
  Needs only flatpak and the SDK (`flatpak install flathub org.freedesktop.Sdk//26.08`).
- `gen-third-party-notices.sh <binary> [linux|macos]`: every Go module linked into the binary (from `go version
-m`) with its license text, then the system libraries loaded at run time. All 27 modules are
  MIT, BSD or ISC; GStreamer and GLib (LGPL) are linked dynamically and not shipped; x264 (GPL,
  compatible with the AGPL) is only a plugin the system or the runtime provides.
- `dev.hfps.OpenliveHelper.yml`: the Flatpak manifest.

## Build the Flatpak

`flatpak-builder` as a Flatpak (per user, nothing system-wide):

```sh
flatpak --user remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak --user install flathub org.flatpak.Builder org.freedesktop.Sdk//26.08 org.freedesktop.Platform//26.08
mkdir -p dist
flatpak run org.flatpak.Builder --user --force-clean --state-dir=build/.flatpak-builder \
  --repo=dist/flatpak-repo build/flatpak packaging/linux/dev.hfps.OpenliveHelper.yml
flatpak build-bundle --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
  dist/flatpak-repo dist/openlive-helper.flatpak dev.hfps.OpenliveHelper
flatpak install --user dist/openlive-helper.flatpak
flatpak run dev.hfps.OpenliveHelper doctor
```

Build in the repository (`build/`, `dist/`): the Builder runs in its own sandbox, which cannot
see `/tmp`. The build downloads the Go toolchain (pinned by checksum) and the Go modules, so
the module has network access during the build; a Flathub submission would vendor the modules
instead (`go mod vendor`, plus a `go-modules` source list).

## Publish to an instance

Members do not download from GitHub: each instance serves the helper itself from its private R2
bucket, to signed-in members of any space and the platform admin (the Download page,
`GET /api/helper/latest`, `GET /api/helper/download/...`). The usual way fills the bucket from an
official release (the public repository's GitHub Releases; [../RELEASING.md](../RELEASING.md)):

```sh
pnpm run helper:publish -- --env production --from-release latest --dry-run   # print the plan
pnpm run helper:publish -- --env production --from-release latest             # or a version: 0.2.0
```

It reads the release from the GitHub REST API (no `gh`, no token), downloads the tarball, the
Flatpak and the macOS disk image (whichever the release has) over HTTPS into
`build/helper-publish/<version>/release/`, checks each against the release's `SHA256SUMS` and its
size, and stops before any upload when one does not match. The protocol version comes from
`helper/internal/api/room.go` at the release's tag, the release notes link defaults to the release
page. `--release-repo owner/name` reads another repository (a fork with its own releases); a draft
is never taken, a prerelease only with `--allow-prerelease`.

To build it yourself instead (an unreleased version, or your own build):

```sh
pnpm run helper:publish -- --env production --version 0.2.0 --dry-run   # print the plan
pnpm run helper:publish -- --env production --version 0.2.0
```

The script (`scripts/setup/src/helper-publish.ts`) then builds with the scripts above
(`build-tarball-in-sdk.sh`, then the Flatpak like the release workflow when `org.flatpak.Builder`
or `flatpak-builder` is installed; `--no-flatpak` leaves it out, `--skip-build` publishes what is in
`dist/`), writes `SHA256SUMS` and `latest.json` into `build/helper-publish/<version>/`, and uploads
with the pinned wrangler and the instance's generated config (`wrangler r2 object put --remote`).
Without `--version` it takes the latest `helper-v*` tag. Both ways write the same layout in the
bucket (the `THUMBNAILS` binding, the instance's only bucket; thumbnails live under `thumbnails/`):

| Key                                                             | What                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `helper/<version>/openlive-helper-<version>-linux-amd64.tar.gz` | The tarball                                                |
| `helper/<version>/openlive-helper-<version>.flatpak`            | The Flatpak bundle (when built)                            |
| `helper/<version>/openlive-helper-<version>-macos.dmg`          | The macOS disk image (when there is one)                   |
| `helper/<version>/SHA256SUMS`                                   | `sha256sum -c` format                                      |
| `helper/latest.json`                                            | Written last: what the Download page offers (format below) |

```json
{
  "schema": 1,
  "version": "0.2.0",
  "publishedAt": "2026-10-28T12:00:00.000Z",
  "protocol": { "major": 1, "minor": 12 },
  "releaseNotesUrl": null,
  "files": [
    {
      "name": "openlive-helper-0.2.0-linux-amd64.tar.gz",
      "kind": "tarball",
      "os": "linux",
      "arch": "amd64",
      "size": 12400000,
      "sha256": "…"
    }
  ],
  "signature": null
}
```

`protocol` is the protocol version the build speaks (`helper/internal/api/room.go`).
`signature` is reserved for the signed auto-update (a signature over this file,
checked with a public key built into the helper); it stays `null`, and the helper does not check
for updates yet. The Worker validates the file (`apps/api/src/helper/release.ts`) and serves only
the file names of a release, with `Content-Disposition: attachment`, `Cache-Control: private` and
a limit of 20 downloads per person per hour.

## What works in the Flatpak (measured on the development machine, 2026-10-27)

NVIDIA RTX 4080, driver 615.78.08, KDE Plasma (Wayland), Flatpak 1.18.4, runtime 26.08
(GStreamer 1.28.6). `flatpak run dev.hfps.OpenliveHelper doctor`:

| Item                                                                    | Status                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NVENC (`nvh264enc`, `cudaupload`)                                       | **Works** with the NVIDIA GL extension that matches the driver (`org.freedesktop.Platform.GL.nvidia-615-78-08`, which flatpak installs with the runtime when Flathub has that driver version): 60 fps at 1080p60, forced IDR in 17 ms. Without the matching extension, nvcodec logs "Cannot load libcuda.so.1" and auto falls back to x264. |
| x264                                                                    | Works (in the runtime).                                                                                                                                                                                                                                                                                                                     |
| VA-API (`vah264enc`, `vapostproc`)                                      | The plugin is in the runtime; it needs a VA driver with H.264 encoding (Mesa for AMD/Intel from `org.freedesktop.Platform.GL.default`, or intel-media-driver). **Untested**: this machine's only VA driver is NVIDIA's decode-only one, so the elements are absent here, as expected.                                                       |
| GL path                                                                 | Works; with one caveat shared with the host: test-pattern frames uploaded to GL come out black on NVIDIA under Wayland EGL (real captures are fine) (helper/README.md, "Encoders"). The `GST_GL_WINDOW=x11` workaround needs an X11 socket in the sandbox: `flatpak override --user --socket=x11 dev.hfps.OpenliveHelper`.                  |
| Portal capture, app audio, tray, shortcuts, notifications, KWin queries | Permissions are in the manifest (PipeWire socket, `org.freedesktop.secrets`, `org.freedesktop.Notifications`, `org.kde.StatusNotifierWatcher` and `org.kde.*` for the item's name, `org.kde.KWin`; the portals need none). Not exercised in the sandbox yet: they need a person at the desktop.                                             |
| Autostart                                                               | `openlive-helper autostart enable` writes into the sandbox's own config directory, which the desktop does not read; a Flatpak needs the Background portal for this (follow-up).                                                                                                                                                             |

**Recommendation for NVIDIA: the tarball**, which uses the system's GStreamer and driver directly.
The Flatpak's NVENC depends on Flathub carrying the GL extension for the exact driver version (a
new driver can run a few days without it, and then the Flatpak encodes with x264).

No `--filesystem=host`: the screen comes through the portal, and the configuration and tokens
live in the sandbox (`~/.var/app/dev.hfps.OpenliveHelper/`), so pair the Flatpak once on its own.
