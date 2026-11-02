# Releasing the helper

The official helper builds live on the public repository's GitHub Releases, one release per
`helper-v<version>` tag. Each release has:

| Asset                                          | Made by                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `openlive-helper-<version>-linux-amd64.tar.gz` | the `release-helper` workflow, in the Flatpak SDK           |
| `openlive-helper-<version>.flatpak`            | the `release-helper` workflow                               |
| `openlive-helper-<version>-macos.dmg`          | the maintainer, on a Mac (signed, notarized and stapled)    |
| `SHA256SUMS`                                   | the workflow, updated by `scripts/release/add-asset.sh`     |
| `*.sha256`                                     | the build scripts (one per file; `SHA256SUMS` is the check) |

Instances do not build anything: `pnpm run helper:publish -- --from-release <version|latest>`
downloads the files of a published release, checks each one against `SHA256SUMS` and its size,
and uploads them to the instance's bucket (docs/self-host.md, section 6).

## Steps (maintainer)

1. **Version.** Pick the helper version (`x.y.z`, usually the project version) and make sure the
   commit to release is on `main` of the public repository (exported with `pnpm export:public`).
2. **Tag.** In the public repository, tag that commit and push the tag:

   ```sh
   git tag -s helper-vX.Y.Z -m "openlive-helper X.Y.Z" && git push origin helper-vX.Y.Z
   ```

   The `release-helper` workflow builds the tarball and the Flatpak and attaches them, with
   `SHA256SUMS`, to a **draft** release for the tag. A re-run replaces those files on the draft
   and keeps the line of a disk image already attached; it never touches a published release.

3. **macOS.** On the Mac, from a checkout of the same commit, in Terminal (not over SSH: the
   keychain is locked there), build the disk image (packaging/macos/README.md):

   ```sh
   VERSION=X.Y.Z MAC_SIGN_IDENTITY="Developer ID Application" MAC_NOTARY_PROFILE=<profile-name> \
     packaging/macos/build-app.sh
   ```

   Then attach it to the draft; the script also adds its SHA-256 to the release's `SHA256SUMS`
   (needs `gh`, logged in with write access):

   ```sh
   scripts/release/add-asset.sh helper-vX.Y.Z dist/openlive-helper-X.Y.Z-macos.dmg
   ```

   It refuses a release that is already published, and a file whose name is not of that version.

4. **Check** the draft: the three files, and `SHA256SUMS` listing all three
   (`gh release download helper-vX.Y.Z --pattern '*' --dir /tmp/check && cd /tmp/check &&
sha256sum -c SHA256SUMS`).
5. **Publish** the draft (on GitHub, or `gh release edit helper-vX.Y.Z --draft=false`). Only a
   published release is visible to `--from-release`; leave the prerelease box unticked unless it
   is one (instances then need `--allow-prerelease`).
6. **Instances.** Publish it to your own instance, and tell self-hosters:

   ```sh
   pnpm run helper:publish -- --env production --from-release X.Y.Z --dry-run
   pnpm run helper:publish -- --env production --from-release X.Y.Z
   ```

A release without the disk image is Linux-only: `--from-release` publishes what the release has,
and the Download page says macOS is not available.

## Unreleased changes

Building from source (`pnpm run helper:publish -- --env production --version X.Y.Z`, with
`--mac-dmg` for a disk image made on a Mac) is still there for a helper that has no release yet,
or for people who want to build it themselves: packaging/linux/README.md.
