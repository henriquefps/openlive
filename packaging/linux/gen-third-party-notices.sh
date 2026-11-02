#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Writes THIRD_PARTY_NOTICES for a built openlive-helper binary:
# every Go module linked into it, with its license text from the module cache, then the
# system libraries it loads at run time, which the tarball does not ship.
#
#   packaging/linux/gen-third-party-notices.sh path/to/openlive-helper [linux|macos] > THIRD_PARTY_NOTICES
#
# The macOS app (packaging/macos/build-app.sh) uses it too, with "macos": the same part 1, and
# the macOS frameworks as part 2. Portable to the BSD tools of macOS.
set -euo pipefail

bin=${1:?usage: $0 path/to/openlive-helper [linux|macos]}
platform=${2:-linux}
here=$(cd "$(dirname "$0")" && pwd)
helper="$here/../../helper"

if [ "$platform" = macos ]; then
	from="they are part of macOS. The capture sidecar (openlive-capture) is Openlive's own
Swift code under the AGPL-3.0, with no third-party packages."
else
	from="they come from the Linux distribution (or, in the Flatpak, from the
org.freedesktop.Platform runtime)."
fi
cat <<EOF
Third-party notices for openlive-helper
=======================================

openlive-helper is licensed under the AGPL-3.0. It contains the Go
modules listed in part 1, each under its own license, reproduced below.

It also loads the system libraries of part 2 at run time. They are not part of this
archive: $from

Part 1: Go modules compiled into the binary
-------------------------------------------
EOF

# "go version -m" lists the modules the binary was built from: "dep <path> <version> <sum>",
# followed by "=> <path> <version>" for a replaced one. A local replacement (this
# repository's own packages) is skipped: its "=>" line has a relative path.
go version -m "$bin" | awk '
	$1 == "dep" { if (pending != "") print pending; pending = $2 " " $3; next }
	$1 == "=>"  { if ($2 !~ /^\.\.?\//) print $2, $3; pending = ""; next }
	END         { if (pending != "") print pending }' |
	sort -u | while read -r path version; do
	dir=$(cd "$helper" && go mod download -json "$path@$version" 2>/dev/null | awk -F'"' '$2 == "Dir" { print $4 }' || true)
	printf '\n### %s %s\n\n' "$path" "$version"
	license=""
	if [ -n "$dir" ]; then
		license=$(find "$dir" -maxdepth 1 -type f \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) | sort | head -n 3)
	fi
	if [ -z "$license" ]; then
		echo "(no license file found in the module; see https://pkg.go.dev/$path?tab=licenses)"
		continue
	fi
	for f in $license; do
		cat "$f"
		echo
	done
done

if [ "$platform" = macos ]; then
	cat <<'EOF'

Part 2: system frameworks loaded at run time (not included)
-----------------------------------------------------------

- ScreenCaptureKit, VideoToolbox (H.264), AudioToolbox and AVFoundation (Opus), CoreMedia,
  CoreVideo, CoreImage, AppKit, UserNotifications and Carbon (global shortcuts): Apple's,
  part of macOS, under the macOS license.
- osascript and afplay, run as separate processes for dialogs and notice sounds: part of macOS.
EOF
	exit 0
fi

cat <<'EOF'

Part 2: system libraries loaded at run time (not included)
----------------------------------------------------------

- GStreamer core and plugins (gstreamer, gst-plugins-base, -good, -bad): LGPL-2.1-or-later,
  linked dynamically through cgo (go-gst). Source: https://gstreamer.freedesktop.org/
- GLib / GObject: LGPL-2.1-or-later, linked dynamically.
- x264 (through gst-plugins-ugly's x264enc, only when that encoder is used): GPL-2.0-or-later,
  loaded as a GStreamer plugin from the system; compatible with the AGPL-3.0.
- PipeWire tools (pw-record, pw-link, pw-dump), run as separate processes for app audio:
  MIT. Source: https://pipewire.org/
- Opus (through gst-plugins-base's opusenc): BSD-3-Clause.
- NVIDIA's CUDA and NVENC libraries (through gst-plugins-bad's nvcodec, when present):
  the NVIDIA driver's license; loaded from the installed driver.
- VA-API (libva) and the GPU's VA driver (through gst-plugins-bad's va, when present):
  MIT (libva), and Mesa's MIT or Intel's media driver (MIT/BSD).
EOF
