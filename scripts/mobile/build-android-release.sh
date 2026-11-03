#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Builds the signed release APK of the Android app. Runs on the Mac, from a folder that holds a
# snapshot of one commit (see apps/mobile/README.md, "Release APK from main").
#
#   OPENLIVE_BUILD_NUMBER=<commit count> scripts/mobile/build-android-release.sh
#
# Environment (all optional except the build number in a folder without .git):
#   OPENLIVE_BUILD_NUMBER   0-9999, the last part of versionCode (commits in the repository)
#   OPENLIVE_KEYS_FILE      signing properties (default ~/.openlive-keys/openlive-upload.properties)
#   OPENLIVE_DIST_DIR       where the APK goes (default ~/openlive-mobile-build/dist)
#   JAVA_HOME, ANDROID_HOME defaults: Android Studio's JBR and ~/Library/Android/sdk
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

KEYS_FILE="${OPENLIVE_KEYS_FILE:-$HOME/.openlive-keys/openlive-upload.properties}"
DIST_DIR="${OPENLIVE_DIST_DIR:-$HOME/openlive-mobile-build/dist}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"

# A private Node/pnpm copy in .tools, when present.
for n in "$ROOT"/.tools/node-v*/bin; do
  [ -d "$n" ] && export PATH="$n:$PATH"
done

die() { echo "error: $*" >&2; exit 1; }

[ -f "$KEYS_FILE" ] || die "signing properties not found: $KEYS_FILE (run the key setup in apps/mobile/README.md)"
# Exported so Gradle reads them from the environment; never printed.
set -a
# shellcheck disable=SC1090
. "$KEYS_FILE"
set +a
for v in OPENLIVE_UPLOAD_STORE_FILE OPENLIVE_UPLOAD_KEY_ALIAS OPENLIVE_UPLOAD_STORE_PASSWORD OPENLIVE_UPLOAD_KEY_PASSWORD; do
  [ -n "${!v:-}" ] || die "$v is empty in $KEYS_FILE"
done
[ -f "$OPENLIVE_UPLOAD_STORE_FILE" ] || die "keystore not found: $OPENLIVE_UPLOAD_STORE_FILE"

if [ -z "${OPENLIVE_BUILD_NUMBER:-}" ]; then
  if [ -e "$ROOT/.git" ]; then
    OPENLIVE_BUILD_NUMBER="$(git rev-list --count HEAD)"
  else
    die "set OPENLIVE_BUILD_NUMBER (git rev-list --count <commit> on the machine with the repository)"
  fi
fi
export OPENLIVE_BUILD_NUMBER

VERSION="$(node -p "require('./apps/mobile/package.json').version")"
echo "Openlive $VERSION, build $OPENLIVE_BUILD_NUMBER"

pnpm install --frozen-lockfile --filter @openlive/mobile...
cd apps/mobile
pnpm exec expo prebuild --platform android --clean --no-install
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a)

APK_BUILT="android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK_BUILT" ] || die "APK not found: $APK_BUILT"

APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
[ -x "$APKSIGNER" ] || die "apksigner not found in $ANDROID_HOME/build-tools"

"$APKSIGNER" verify --verbose "$APK_BUILT" >/dev/null || die "apksigner verify failed"
CERT="$("$APKSIGNER" verify --print-certs "$APK_BUILT" | sed -n 's/^V[0-9]* Signer.*certificate SHA-256 digest: //p' | head -1)"
[ -n "$CERT" ] || die "could not read the certificate digest"
DEBUG_CERT="$(keytool -list -v -keystore android/app/debug.keystore -storepass android -alias androiddebugkey \
  | sed -n 's/^ *SHA256: //p' | tr -d ':' | tr 'A-F' 'a-f')"
[ "$CERT" != "$DEBUG_CERT" ] || die "the APK is signed with the public debug key"

mkdir -p "$DIST_DIR"
OUT="$DIST_DIR/openlive-$VERSION-android.apk"
cp "$APK_BUILT" "$OUT"
(cd "$DIST_DIR" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")

echo
echo "APK:         $OUT"
echo "SHA-256:     $(cut -d' ' -f1 "$OUT.sha256")"
echo "Cert SHA-256: $CERT"
