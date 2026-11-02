#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Runs build-tarball.sh inside the Flatpak SDK (org.freedesktop.Sdk, the version the Flatpak
# manifest uses), so the release binary links the SDK's GStreamer (1.28 on 26.08) instead of a
# build machine's older one: go-gst does not build against Ubuntu 24.04's GStreamer 1.24. The
# release-helper workflow and a local release build both use it.
#
#   VERSION=0.1.0 packaging/linux/build-tarball-in-sdk.sh   # → dist/openlive-helper-0.1.0-linux-amd64.tar.gz
#
# Needs flatpak with org.freedesktop.Sdk//<runtime-version> installed (packaging/linux/README.md).
# Go is the toolchain the manifest pins, downloaded once into build/ and checked against its
# sha256. The binary needs the glibc of the SDK or older symbols only; rolling distributions
# (Arch, Fedora) have it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
manifest=$here/dev.hfps.OpenliveHelper.yml
sdk=org.freedesktop.Sdk//$(sed -n "s/^runtime-version: '\(.*\)'$/\1/p" "$manifest")
go_url=$(sed -n 's|^ *url: \(https://go.dev/dl/go.*\.linux-amd64\.tar\.gz\)$|\1|p' "$manifest")
go_sha=$(sed -n '\|url: https://go.dev/dl/|{n;s/^ *sha256: //p}' "$manifest")
out=${OUT_DIR:-$root/dist}
cache=$root/build/sdk-go
goroot=$cache/$(basename "$go_url" .linux-amd64.tar.gz)

if [ ! -x "$goroot/go/bin/go" ]; then
	echo "downloading $go_url"
	mkdir -p "$goroot"
	curl -fsSL "$go_url" -o "$cache/go.tar.gz"
	echo "$go_sha  $cache/go.tar.gz" | sha256sum -c --quiet
	tar -C "$goroot" -xzf "$cache/go.tar.gz"
	rm "$cache/go.tar.gz"
fi
mkdir -p "$out" "$cache/gopath" "$cache/gocache"

echo "building in $sdk"
# The SDK runs as a sandbox: it sees the repository, the output directory and the network
# (Go modules), nothing else of the host. -buildvcs=false: a git worktree's .git points
# outside the repository, where the sandbox cannot look.
flatpak run --share=network --filesystem="$root" --filesystem="$out" \
	--env=PATH="$goroot/go/bin:/usr/bin" --env=GOTOOLCHAIN=local \
	--env=GOPATH="$cache/gopath" --env=GOCACHE="$cache/gocache" \
	--env=GOFLAGS="-buildvcs=false -modcacherw" \
	--env=VERSION="${VERSION:-}" --env=OUT_DIR="$out" --env=GOARCH=amd64 \
	--command=bash "$sdk" -c 'cd "$1" && packaging/linux/build-tarball.sh' _ "$root"
