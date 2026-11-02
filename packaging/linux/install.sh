#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-only
# Installs the helper from this archive for the current user (no root):
#   ./install.sh              # into ~/.local
#   PREFIX=/usr/local ./install.sh   # elsewhere (as root)
# GStreamer comes from the distribution: see share/doc/openlive-helper/README.md
# ("Install on Linux") for the packages.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
prefix=${PREFIX:-$HOME/.local}
app=dev.hfps.OpenliveHelper

install -Dm755 "$here/bin/openlive-helper" "$prefix/bin/openlive-helper"
install -Dm644 "$here/share/metainfo/$app.metainfo.xml" "$prefix/share/metainfo/$app.metainfo.xml"
install -Dm644 "$here/share/icons/hicolor/scalable/apps/$app.svg" "$prefix/share/icons/hicolor/scalable/apps/$app.svg"
install -Dm644 "$here/share/icons/hicolor/256x256/apps/$app.png" "$prefix/share/icons/hicolor/256x256/apps/$app.png"
mkdir -p "$prefix/share/applications"
# The menu entry runs the installed binary by its full path (~/.local/bin is not always on PATH).
sed "s|^Exec=openlive-helper|Exec=$prefix/bin/openlive-helper|" "$here/share/applications/$app.desktop" \
	>"$prefix/share/applications/$app.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$prefix/share/applications" || true

echo "Installed $prefix/bin/openlive-helper"
case ":$PATH:" in *":$prefix/bin:"*) ;; *) echo "Add $prefix/bin to your PATH to run openlive-helper from a terminal." ;; esac
echo "Next: openlive-helper pair --instance https://your-instance"
