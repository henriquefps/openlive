# macOS packaging of the helper

One release artifact: `openlive-helper-<version>-macos.dmg`, a disk image with
**Openlive Helper.app** and a link to Applications. The app is universal (Apple silicon and
Intel), needs macOS 13 or later, is signed with a Developer ID Application certificate with the
hardened runtime, and the app and the disk image are both notarized and stapled.

```
Openlive Helper.app/Contents/
  Info.plist                 dev.hfps.OpenliveHelper, LSUIElement, LSMinimumSystemVersion 13.0,
                             NSScreenCaptureUsageDescription, CFBundleExecutable openlive-helper
  MacOS/openlive-helper      the Go helper (universal, no cgo)
  MacOS/openlive-capture     the Swift sidecar and menu bar agent (universal; next to the helper,
                             so the agent has the bundle's identity: helper/macos-capture/README.md)
  Resources/AppIcon.icns     from AppIcon.svg
  Resources/LICENSE, THIRD_PARTY_NOTICES
```

## Files

- `build-app.sh`: build → sign → notarize → staple → disk image, on a Mac.
- `AppIcon.svg`: the helper's icon (`packaging/linux/icons`) on macOS's 1024 grid (an 824-pixel
  rounded square, centred); the script renders the `.iconset` with `rsvg-convert` or ImageMagick
  and `iconutil`.
- `../linux/gen-third-party-notices.sh <binary> macos`: the Go modules' licenses, then the macOS
  frameworks.

## Build a release (maintainer)

Once per Mac:

- Xcode (for `swift`, `codesign`, `notarytool`, `stapler`), Go (`brew install go`; the toolchain
  in `helper/go.mod` is fetched automatically), and `brew install librsvg` or `imagemagick`.
- A **Developer ID Application** certificate with its private key in the login keychain
  (`security find-identity -v -p codesigning` lists it).
- The notary credentials as a keychain profile, made once in Terminal (it asks for the App Store
  Connect API key, or an Apple ID with an app-specific password, and stores them in the keychain):

  ```sh
  xcrun notarytool store-credentials <profile-name>
  ```

- The first `codesign` with the certificate asks for keychain access: type the login password in
  the dialog and pick **Always Allow**, or every build stops at that dialog.

Then, from the repository root, **in Terminal on the Mac** (not over SSH: the login keychain is
locked there, and `codesign` fails with `errSecInternalComponent` or waits for a dialog no one
sees):

```sh
MAC_SIGN_IDENTITY="Developer ID Application" MAC_NOTARY_PROFILE=<profile-name> \
  packaging/macos/build-app.sh
```

`MAC_SIGN_IDENTITY` is the certificate's SHA-1 or a unique part of its name. Never commit either
value. The script prints each step; the team name and id are left out of its output. It ends with
`dist/openlive-helper-<version>-macos.dmg` and its `.sha256`, after:

- `codesign --verify --strict --deep` on the app;
- `notarytool submit --wait` (a few minutes each), `stapler staple` and `stapler validate`, for
  the app and then for the disk image; on a rejection it prints notarytool's log and stops;
- `spctl --assess --type execute` on the app and `--type open --context
context:primary-signature` on the disk image (both "accepted, source=Notarized Developer ID").

`VERSION=x.y.z` overrides the project version; `NOTARIZE=0` signs without notarizing (a quick
check of the bundle; Gatekeeper refuses it); `MAC_SIGN_IDENTITY=-` signs ad hoc (development).

Check what a friend gets, with a quarantined copy (as a browser download would be):

```sh
hdiutil attach dist/openlive-helper-<version>-macos.dmg
ditto "/Volumes/Openlive Helper/Openlive Helper.app" /tmp/olh/"Openlive Helper.app"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" /tmp/olh/"Openlive Helper.app"
spctl --assess --type execute -vv /tmp/olh/"Openlive Helper.app"   # accepted, Notarized Developer ID
hdiutil detach "/Volumes/Openlive Helper"
```

## Attach it to the release (maintainer)

The official disk image goes on the public repository's GitHub release for the tag, next to the
Linux files the `release-helper` workflow attached to the draft (the full order is in
[../RELEASING.md](../RELEASING.md)). From the Mac, with `gh` logged in:

```sh
scripts/release/add-asset.sh helper-v<version> dist/openlive-helper-<version>-macos.dmg
```

It uploads the image to the **draft** release and adds its SHA-256 to the release's `SHA256SUMS`,
which `helper:publish --from-release` checks every file against. Then publish the draft.

## Publish to an instance

From a release (what self-hosters do; no Mac needed): the instance links to the disk image on
GitHub, next to the Linux files.

```sh
pnpm run helper:publish -- --env production --from-release <version> --dry-run
pnpm run helper:publish -- --env production --from-release <version>
```

From your own build (an unreleased version, or a build of your own): copy the image to the
machine you publish from (into `dist/`) and add it to a local build:

```sh
pnpm run helper:publish -- --env production --mac-dmg dist/openlive-helper-<version>-macos.dmg --dry-run
pnpm run helper:publish -- --env production --mac-dmg dist/openlive-helper-<version>-macos.dmg
```

The name must carry the version being published (the Linux files are built for the same one).
From a release the manifest names the image's GitHub URL; from your own build it is uploaded next
to the Linux files and listed in `SHA256SUMS`. Either way it is in `helper/latest.json` (`kind: dmg`, `os: macos`, `arch: universal`, with its size and SHA-256), and
`/download` shows the macOS card with the install steps.

## What the app does when opened

`helper/cmd/openlive-helper/app.go`. Finder starts the app with no arguments:

1. From the disk image or a translocated copy, it asks to be dragged to Applications.
2. Not paired: a dialog asks for the instance address; the browser opens the confirmation page
   with the code filled in (a notification repeats the code).
3. The sidecar's `list` lets macOS ask for **Screen Recording** for "Openlive Helper".
4. It writes `~/Library/LaunchAgents/dev.hfps.OpenliveHelper.plist` (`run --instance …
--minimized` with the app's binary, its version and the system locale) and has launchd start
   it: the menu bar item appears. The helper then starts at every login (turn it off under System
   Settings > General > Login Items, or `openlive-helper autostart disable`).

Opening the app again starts the helper if it is not running (after **Quit** in its menu).
**Updating:** Quit from the menu, replace the app in Applications with the new one, open it: the
new version changes the plist, so the LaunchAgent is reloaded with it. (While the menu bar item
runs, macOS may count the app as already open and not start it again, hence Quit first.)
The log is `~/Library/Logs/openlive-helper.log`.

**Permissions do not carry over from development builds**: they had another code identity, so
macOS asks again for the app (and lists the old entries until they are removed). Removing the app:
quit it from its menu, `"/Applications/Openlive Helper.app/Contents/MacOS/openlive-helper"
autostart disable`, then drag it to the Trash.
