#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Builds the macOS release of the helper (packaging/macos/README.md): "Openlive
# Helper.app" with the Go helper and the Swift sidecar, both universal (arm64 + x86_64), signed
# inside-out with the Developer ID and the hardened runtime, notarized and stapled, inside a
# signed, notarized and stapled disk image with an Applications link.
#
#   MAC_SIGN_IDENTITY=<SHA-1 or name> MAC_NOTARY_PROFILE=<notarytool keychain profile> \
#     packaging/macos/build-app.sh          # → dist/openlive-helper-<version>-macos.dmg
#
# Run it on a Mac, in a Terminal of the logged-in session: codesign and notarytool need the
# unlocked login keychain, which an SSH session does not have. Nothing secret is in here or in
# its output: the identity and the notary profile come from the environment, and notarytool
# reads the credentials from the keychain.
#
#   VERSION=x.y.z       the version (default: the project version in package.json)
#   NOTARIZE=0          sign only, no notarization (a local test; Gatekeeper will refuse it)
#   MAC_SIGN_IDENTITY=- ad-hoc signature, implies NOTARIZE=0 (development only)
#   OUT_DIR=dir         where the .app and the .dmg go (default: dist/)
#
# Needs Xcode (swift, codesign, notarytool, stapler), Go, and rsvg-convert or ImageMagick.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
[ "$(uname)" = Darwin ] || { echo "build-app.sh: run this on a Mac" >&2; exit 1; }

version=${VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$root/package.json")}
[ -n "$version" ] || { echo "build-app.sh: no version: set VERSION" >&2; exit 1; }
identity=${MAC_SIGN_IDENTITY:?set MAC_SIGN_IDENTITY to the Developer ID Application identity (or - for ad hoc)}
notarize=${NOTARIZE:-1}
[ "$identity" = - ] && notarize=0
if [ "$notarize" = 1 ]; then
	profile=${MAC_NOTARY_PROFILE:?set MAC_NOTARY_PROFILE to the notarytool keychain profile (or NOTARIZE=0)}
fi
out=${OUT_DIR:-$root/dist}
app_name="Openlive Helper"
bundle_id=dev.hfps.OpenliveHelper
app="$out/$app_name.app"
dmg="$out/openlive-helper-$version-macos.dmg"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

step() { printf '\n==> %s\n' "$*"; }
# The team's name and id stay out of the output (it ends up in logs and PRs).
private() { sed -e 's/^origin=.*/origin=(Developer ID, team hidden)/' -e 's/^TeamIdentifier=.*/TeamIdentifier=(set)/'; }

step "Go helper $version (arm64 + x86_64)"
for arch in arm64 amd64; do
	(cd "$root/helper" && CGO_ENABLED=0 GOOS=darwin GOARCH=$arch \
		go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$work/openlive-helper-$arch" ./cmd/openlive-helper)
done
lipo -create -output "$work/openlive-helper" "$work/openlive-helper-arm64" "$work/openlive-helper-amd64"

step "Swift sidecar (arm64 + x86_64)"
swift build -c release --arch arm64 --arch x86_64 --package-path "$root/helper/macos-capture"
sidecar="$(swift build -c release --arch arm64 --arch x86_64 --package-path "$root/helper/macos-capture" --show-bin-path)/openlive-capture"
lipo -info "$sidecar"

step "Icon"
iconset="$work/AppIcon.iconset"
mkdir -p "$iconset"
render() { # size out
	if command -v rsvg-convert >/dev/null; then
		rsvg-convert -w "$1" -h "$1" "$here/AppIcon.svg" -o "$2"
	else
		magick -background none -density 384 "$here/AppIcon.svg" -resize "$1x$1" "$2"
	fi
}
for s in 16 32 128 256 512; do
	render "$s" "$iconset/icon_${s}x${s}.png"
	render $((s * 2)) "$iconset/icon_${s}x${s}@2x.png"
done
iconutil -c icns -o "$work/AppIcon.icns" "$iconset"

step "Bundle $app"
# The layout macos-capture/README.md "App bundle" fixes: both executables in Contents/MacOS, so
# the agent (openlive-capture agent) has the bundle's identity for UserNotifications, and the
# helper finds the sidecar next to itself.
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$work/openlive-helper" "$app/Contents/MacOS/openlive-helper"
cp "$sidecar" "$app/Contents/MacOS/openlive-capture"
cp "$work/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
cp "$root/LICENSE" "$app/Contents/Resources/LICENSE"
"$root/packaging/linux/gen-third-party-notices.sh" "$work/openlive-helper-arm64" macos >"$app/Contents/Resources/THIRD_PARTY_NOTICES"
cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>$bundle_id</string>
	<key>CFBundleName</key>
	<string>$app_name</string>
	<key>CFBundleDisplayName</key>
	<string>$app_name</string>
	<key>CFBundleExecutable</key>
	<string>openlive-helper</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleLocalizations</key>
	<array>
		<string>en</string>
		<string>pt-BR</string>
	</array>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.video</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>AGPL-3.0-only. https://github.com/henriquefps/openlive</string>
	<key>NSScreenCaptureUsageDescription</key>
	<string>Openlive streams the screen or window you choose to your room.</string>
</dict>
</plist>
EOF
plutil -lint "$app/Contents/Info.plist"

step "Sign (inside out, hardened runtime, secure timestamp, no entitlements)"
sign() { # identifier path
	if [ "$identity" = - ]; then
		codesign --force --sign - --options runtime --identifier "$1" "$2"
	else
		codesign --force --sign "$identity" --options runtime --timestamp --identifier "$1" "$2"
	fi
}
# The nested executable first, then the bundle, which seals it and signs the main executable.
sign "$bundle_id.capture" "$app/Contents/MacOS/openlive-capture"
sign "$bundle_id" "$app"
codesign --verify --strict --deep --verbose=2 "$app"
codesign --display --verbose=2 "$app" 2>&1 | grep -E '^(Identifier|Format|Runtime Version|Timestamp|TeamIdentifier)=|flags=' | private

notarize() { # path
	local zip=$1 json="$work/notary.json"
	step "Notarize $(basename "$1")"
	if [ -d "$1" ]; then
		zip="$work/$(basename "$1").zip"
		ditto -c -k --keepParent "$1" "$zip"
	fi
	local status id attempt
	# A network error (a connect timeout to Apple or to the upload bucket) leaves no submission
	# id: submit again, up to three times.
	for attempt in 1 2 3; do
		xcrun notarytool submit "$zip" --keychain-profile "$profile" --wait --timeout 1h --output-format json >"$json" || true
		id=$(plutil -extract id raw -o - "$json" 2>/dev/null || echo "")
		[ -n "$id" ] || [ "$attempt" = 3 ] && break
		echo "notarytool: no submission (network error?), retrying in 30 s" >&2
		sleep 30
	done
	status=$(plutil -extract status raw -o - "$json" 2>/dev/null || echo unknown)
	echo "notarytool: $status ($id)"
	if [ "$status" != Accepted ]; then
		[ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$profile" >&2 || cat "$json" >&2
		echo "build-app.sh: notarization of $(basename "$1") failed" >&2
		exit 1
	fi
	xcrun stapler staple "$1"
	xcrun stapler validate "$1"
}

if [ "$notarize" = 1 ]; then
	notarize "$app"
	spctl --assess --type execute --verbose=2 "$app" 2>&1 | private
fi

step "Disk image $dmg"
stage="$work/dmg"
mkdir -p "$stage"
ditto "$app" "$stage/$app_name.app"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -volname "$app_name" -srcfolder "$stage" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$dmg"
if [ "$identity" = - ]; then
	codesign --force --sign - "$dmg"
else
	codesign --force --sign "$identity" --timestamp --identifier "$bundle_id.dmg" "$dmg"
fi
codesign --verify --verbose=2 "$dmg"

if [ "$notarize" = 1 ]; then
	notarize "$dmg"
	spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg" 2>&1 | private
fi

(cd "$out" && shasum -a 256 "$(basename "$dmg")" | tee "$(basename "$dmg").sha256")
ls -l "$dmg"
echo "$dmg"
