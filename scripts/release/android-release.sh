#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Drafts the GitHub pre-release of the Android app (beta) on the PUBLIC repository.
#
#   scripts/release/android-release.sh 0.1.4 --mac user@host --dry-run
#   scripts/release/android-release.sh 0.1.4 --mac user@host [--target <public commit sha>]
#
# It copies openlive-<version>-android.apk and its .sha256 from the Mac that built them
# (scripts/mobile/build-android-release.sh, apps/mobile/README.md "Release APK from main") into
# dist/, checks the SHA-256 and that the APK is signed with the expected certificate
# (EXPECTED_CERT_SHA256 below; with apksigner here if there is one, otherwise on the Mac over ssh),
# and creates the DRAFT pre-release android-v<version> with the APK, its .sha256 and SHA256SUMS.
# The notes come from scripts/release/android-release-notes.md.tmpl plus the "Android app (beta)"
# part of the version's CHANGELOG.md entry. It never publishes: review the draft on GitHub, then
# publish it by hand (or `gh release edit android-v<version> --draft=false`).
#
# Options and environment:
#   --mac <ssh host>     the Mac that built the APK (or OPENLIVE_MAC); not needed when the files
#                        are already in dist/
#   --target <sha>       the PUBLIC repository's commit the tag points at, the one the build
#                        matches (default: the head of its main branch)
#   --dry-run            copy and check, print the plan and the notes, create nothing
#   MAC_DIST_DIR         where the Mac keeps the APK (default ~/openlive-mobile-build/dist)
#   REPO=owner/name      default henriquefps/openlive
#
# Needs gh (write access to the repository), ssh/scp for the Mac, and sha256sum or shasum.
set -euo pipefail

# SHA-256 of the certificate of our signing key (apps/mobile/README.md). Public: it is what lets
# people check the APK. Change it only when the key changes, together with that README.
EXPECTED_CERT_SHA256=c50fefe1f7c2db45ce34ad06c96dbc8729a6de801a5276ff53d30e035eda9c16

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo=${REPO:-henriquefps/openlive}
mac=${OPENLIVE_MAC:-}
mac_dist=${MAC_DIST_DIR:-openlive-mobile-build/dist}
version=
target=
dry=0

die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '3,4p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

while [ $# -gt 0 ]; do
	case "$1" in
	--mac) mac=${2:-}; shift 2 ;;
	--target) target=${2:-}; shift 2 ;;
	--dry-run) dry=1; shift ;;
	-h | --help) usage ;;
	-*) die "unknown option $1" ;;
	*) [ -z "$version" ] || usage; version=$1; shift ;;
	esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
tag="android-v$version"
apk="openlive-$version-android.apk"
dist="$ROOT/dist"

sha_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# 1. The files, from the Mac unless they are already here.
mkdir -p "$dist"
if [ -n "$mac" ]; then
	echo "Copying $apk and its .sha256 from $mac"
	scp -q "$mac:$mac_dist/$apk" "$mac:$mac_dist/$apk.sha256" "$dist/"
fi
[ -f "$dist/$apk" ] && [ -f "$dist/$apk.sha256" ] ||
	die "$dist/$apk(.sha256) not found: pass --mac <ssh host> (or OPENLIVE_MAC)"

# 2. The checksum.
apk_sha=$(sha_of "$dist/$apk")
listed=$(cut -d' ' -f1 "$dist/$apk.sha256")
[ "$apk_sha" = "$listed" ] || die "$apk does not match its .sha256 file ($apk_sha != $listed)"
echo "SHA-256 ok: $apk_sha"

# 3. The signing certificate.
apksigner=$(command -v apksigner || true)
if [ -z "$apksigner" ] && [ -n "${ANDROID_HOME:-}" ]; then
	apksigner=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)
fi
cert_of() { sed -n 's/^V[0-9]* Signer.*certificate SHA-256 digest: //p' | head -1; }
if [ -n "$apksigner" ]; then
	cert=$("$apksigner" verify --print-certs "$dist/$apk" | cert_of)
elif [ -n "$mac" ]; then
	# shellcheck disable=SC2016  # expanded on the Mac
	cert=$(ssh "$mac" 'export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
		A=$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/build-tools/*/apksigner | sort -V | tail -1)
		"$A" verify --print-certs "$HOME/'"$mac_dist/$apk"'"' | cert_of)
else
	die "no apksigner here (put the Android SDK build-tools on PATH or set ANDROID_HOME) and no --mac to check on"
fi
[ -n "$cert" ] || die "could not read the certificate of $apk"
[ "$cert" = "$EXPECTED_CERT_SHA256" ] ||
	die "$apk is signed with another certificate ($cert, expected $EXPECTED_CERT_SHA256)"
echo "Certificate SHA-256 ok: $cert"

# 4. The tag's commit.
if [ -z "$target" ]; then
	target=$(gh api "repos/$repo/commits/main" --jq .sha)
fi
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || die "--target must be a full commit sha of $repo"
gh api "repos/$repo/commits/$target" --jq .sha >/dev/null || die "$target is not a commit of $repo"

# 5. SHA256SUMS and the notes.
sums="$dist/SHA256SUMS-android-$version"
printf '%s  %s\n' "$apk_sha" "$apk" >"$sums"
changes=$(awk -v v="## $version " '
	index($0, v) == 1 { inv = 1; next }
	inv && /^## / { exit }
	inv && /^\*\*Android app \(beta\)\*\*/ { on = 1 }
	on && /^\*\*/ && !/^\*\*Android app/ { exit }
	on && !/^\*\*Android app/ { print }' "$ROOT/CHANGELOG.md" | sed -e '/./,$!d' -e :a -e '/^\n*$/{$d;N;ba' -e '}')
[ -n "$changes" ] || die "CHANGELOG.md has no **Android app (beta)** part in the $version entry"
notes="$dist/android-$version-notes.md"
awk -v ver="$version" -v apk="$apk" -v sha="$apk_sha" -v cert="$cert" -v changes="$changes" '
	{ gsub(/\{\{VERSION\}\}/, ver); gsub(/\{\{APK\}\}/, apk); gsub(/\{\{APK_SHA\}\}/, sha); gsub(/\{\{CERT\}\}/, cert) }
	/\{\{CHANGES\}\}/ { print changes; next }
	{ print }' "$ROOT/scripts/release/android-release-notes.md.tmpl" >"$notes"

if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
	die "$tag already exists on github.com/$repo; this script only creates new drafts"
fi

echo
echo "Release:  $tag (draft, pre-release) on github.com/$repo"
echo "Commit:   $target"
echo "Assets:   $apk, $apk.sha256, SHA256SUMS"
echo "Notes:    $notes"
if [ "$dry" = 1 ]; then
	echo
	echo "--dry-run: nothing created. The notes would be:"
	echo "-----"
	cat "$notes"
	exit 0
fi

# gh uploads the asset under the file's name: SHA256SUMS needs a file of that name.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$sums" "$stage/SHA256SUMS"
gh release create "$tag" --repo "$repo" --draft --prerelease --target "$target" \
	--title "Openlive Android app $version (beta)" --notes-file "$notes" \
	"$dist/$apk" "$dist/$apk.sha256" "$stage/SHA256SUMS"
echo
echo "Draft created. Review it on GitHub; it is not published."
