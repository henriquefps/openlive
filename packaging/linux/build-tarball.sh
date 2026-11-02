#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Builds the Linux release tarball of the helper: the binary for
# linux/amd64 (cgo, GStreamer linked dynamically) with its version stamped, the desktop
# entry, the AppStream metainfo, the icons, an install script and THIRD_PARTY_NOTICES.
#
#   VERSION=0.1.0 packaging/linux/build-tarball.sh     # → dist/openlive-helper-0.1.0-linux-amd64.tar.gz
#
# Needs Go, a C compiler and the GStreamer development files (pkg-config gstreamer-1.0,
# gstreamer-video-1.0, gstreamer-app-1.0), plus rsvg-convert or ImageMagick for the PNG icon.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
app=dev.hfps.OpenliveHelper
version=${VERSION:-$(git -C "$root" describe --tags --match 'helper-v*' 2>/dev/null | sed 's/^helper-v//' || true)}
version=${version:-0.1.0-dev}
arch=${GOARCH:-amd64}
out=${OUT_DIR:-$root/dist}
name=openlive-helper-$version-linux-$arch

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage=$work/$name
mkdir -p "$stage/bin" "$stage/share/applications" "$stage/share/metainfo" \
	"$stage/share/icons/hicolor/scalable/apps" "$stage/share/icons/hicolor/256x256/apps" \
	"$stage/share/doc/openlive-helper" "$out"

echo "building openlive-helper $version (linux/$arch)"
(cd "$root/helper" && CGO_ENABLED=1 GOOS=linux GOARCH=$arch \
	go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$stage/bin/openlive-helper" ./cmd/openlive-helper)

install -m644 "$here/$app.desktop" "$stage/share/applications/$app.desktop"
install -m644 "$here/$app.metainfo.xml" "$stage/share/metainfo/$app.metainfo.xml"
install -m644 "$here/icons/$app.svg" "$stage/share/icons/hicolor/scalable/apps/$app.svg"
png="$stage/share/icons/hicolor/256x256/apps/$app.png"
if command -v rsvg-convert >/dev/null; then
	rsvg-convert -w 256 -h 256 "$here/icons/$app.svg" -o "$png"
else
	magick -background none "$here/icons/$app.svg" -resize 256x256 "$png"
fi
install -m644 "$root/helper/README.md" "$stage/share/doc/openlive-helper/README.md"
install -m755 "$here/install.sh" "$stage/install.sh"
"$here/gen-third-party-notices.sh" "$stage/bin/openlive-helper" >"$stage/THIRD_PARTY_NOTICES"

tar -C "$work" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
echo "$out/$name.tar.gz"
"$stage/bin/openlive-helper" version
