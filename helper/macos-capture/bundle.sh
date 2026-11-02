#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Wraps a built openlive-capture in a minimal development app bundle, OpenliveHelper.app, next
# to the helper's binary. The menu bar agent needs the bundle for UserNotifications (macOS only
# lets a process with a bundle identity post them); the captures run from it too. README.md
# "App bundle" lists what the notarized .app must keep.
#
#   MAC_SIGN_IDENTITY=<SHA-1 or name> ./bundle.sh [.build/release/openlive-capture] [../build]
set -eu

bin=${1:-.build/release/openlive-capture}
out=${2:-../build}
version=${OPENLIVE_VERSION:-0.1.0}
app="$out/OpenliveHelper.app"

[ -x "$bin" ] || { echo "bundle.sh: $bin not found: swift build -c release first" >&2; exit 1; }
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/openlive-capture"
cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>dev.hfps.OpenliveHelper</string>
	<key>CFBundleName</key>
	<string>Openlive Helper</string>
	<key>CFBundleDisplayName</key>
	<string>Openlive Helper</string>
	<key>CFBundleExecutable</key>
	<string>openlive-capture</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSScreenCaptureUsageDescription</key>
	<string>Openlive streams the screen or window you choose to your room.</string>
</dict>
</plist>
EOF
plutil -lint "$app/Contents/Info.plist" >/dev/null
if [ -n "${MAC_SIGN_IDENTITY:-}" ]; then
	codesign --force --sign "$MAC_SIGN_IDENTITY" "$app"
else
	echo "bundle.sh: MAC_SIGN_IDENTITY is not set: signing ad hoc (macOS asks for permissions again after every build)" >&2
	codesign --force --sign - "$app"
fi
# Tell Launch Services about the bundle, so notifications know its name.
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$lsregister" ] && "$lsregister" -f "$app" || true
echo "$app"
