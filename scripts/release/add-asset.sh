#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Attaches a file to a draft helper release on GitHub and updates the release's SHA256SUMS with
# its SHA-256 (packaging/RELEASING.md). Used for the notarized macOS disk image, which is built
# on a Mac, after the release-helper workflow drafted the release with the Linux files.
#
#   scripts/release/add-asset.sh helper-v0.2.0 dist/openlive-helper-0.2.0-macos.dmg
#   REPO=owner/name scripts/release/add-asset.sh ...   # default: the public repository
#
# Needs gh, logged in with write access to the repository, and sha256sum or shasum. Refuses a
# published release: its files and checksums must not change after people downloaded them.
set -euo pipefail

tag=${1:-}
file=${2:-}
repo=${REPO:-henriquefps/openlive}
if [ -z "$tag" ] || [ -z "$file" ] || [ $# -ne 2 ]; then
	echo "usage: scripts/release/add-asset.sh helper-v<version> <file>" >&2
	exit 2
fi
if [ ! -f "$file" ]; then
	echo "$file: no such file" >&2
	exit 1
fi
name=$(basename "$file")
version=${tag#helper-v}
case "$name" in
openlive-helper-"$version"[-.]*) ;;
*)
	echo "$name is not a file of $tag (openlive-helper-$version-...)" >&2
	exit 1
	;;
esac
if [ "$name" = SHA256SUMS ]; then
	echo "SHA256SUMS is updated by this script; pass the file to add" >&2
	exit 1
fi

draft=$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft) || {
	echo "no release $tag on github.com/$repo (push the tag and let the release-helper workflow draft it)" >&2
	exit 1
}
if [ "$draft" != true ]; then
	echo "$tag is already published; not changing its files" >&2
	exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
	sum=$(sha256sum "$file" | cut -d' ' -f1)
else
	sum=$(shasum -a 256 "$file" | cut -d' ' -f1)
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh release download "$tag" --repo "$repo" --pattern SHA256SUMS --dir "$work" 2>/dev/null ||
	: >"$work/SHA256SUMS"
# Replace this file's line (a re-upload), keep the others, sorted like the workflow writes them.
{
	awk -v n="$name" '$2 != n' "$work/SHA256SUMS"
	printf '%s  %s\n' "$sum" "$name"
} | sort -k2 >"$work/SHA256SUMS.new"
mv "$work/SHA256SUMS.new" "$work/SHA256SUMS"

echo "Uploading $name to $tag on github.com/$repo"
gh release upload "$tag" --repo "$repo" --clobber "$file"
gh release upload "$tag" --repo "$repo" --clobber "$work/SHA256SUMS"
echo "SHA256SUMS of $tag now:"
cat "$work/SHA256SUMS"
