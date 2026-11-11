# README screenshots

`pnpm screenshots` takes the gallery of the root README (`docs/img/screens/`) from the real web
app, against a local instance with fictional data. Run it again after a UI change and commit the
images.

What it does, in order (`src/main.ts`):

1. Applies the D1 migrations to a throwaway state directory and starts `wrangler dev` on
   **:8799** (with `DEV_AUTH=1` and a random `SESSION_SECRET`) and Vite on **:5188** (or
   `SHOTS_API_PORT`, `SHOTS_WEB_PORT`). It stops if
   either port is taken, and stops both (and everything else it started) at the end.
2. Seeds made-up users (Ana, the platform admin; Bruno; Carla; Diego; Eva; Felipe) straight into
   the local D1 and uploads each one's profile photo through `PUT /api/me/avatar`, then the space
   "Friends" with the rooms "Movie night" (stream, voice, cameras, text), "Games" (stream),
   "Hangout" (voice with cameras) and "General" (text), the invites, a second space, a month of
   estimated usage through the API as those users, and a helper and Android release published from
   GitHub (the local bucket's `helper/latest.json` and `helper/android.json`) for the Download page.
3. With the dev Realtime credentials, builds the helper, pairs two copies, and has Bruno publish
   `stream-movie` into "Movie night" (`test-stream --test-image`) while Ana's waits for **Go live**
   with `stream-game` (`run --test-source --test-image`), which she starts in "Games". Without
   them, the room, player and Go live shots are skipped.
4. Drives headless Chrome (`playwright-core` with the installed Google Chrome) through each screen
   in light and dark at 1440 px, and a few at 390 px, and writes palette PNGs with `sharp`. Every
   signed-in page gets a fake camera and microphone (an init script over `getUserMedia`): the
   camera is that person's `cam-<name>` picture on a canvas with a slow zoom and pan, sent as a real
   video track; the microphone is a tone that only the person set to speak makes audible, so the
   speaking ring lands on one tile. Carla is the one on screen; in "Movie night" Bruno, Diego and
   Eva are on camera and Ana and Felipe in voice only (Diego speaking), in "Hangout" everyone but
   Ana is on camera (Eva speaking).

## Pictures

`assets/` holds the committed pictures (JPEG, AI-generated made-up people; see
[assets/README.md](assets/README.md)): `avatar-<name>.jpg`, `cam-<name>.jpg` for each of the six
people, and `stream-game.jpg`, `stream-movie.jpg`, `stream-desktop.jpg` (spare: no shot uses it yet). A missing one is drawn
as a neutral stand-in (a gradient with initials, or a simple scene) in the git-ignored
`.provisional/`, and the run logs which, so never commit a gallery made with stand-ins.

The dev Realtime credentials come from `OPENLIVE_DEV_VARS`, or `.dev.vars` at the root of the main
checkout. Wrangler reads them with `--env-file`; the script never reads or copies them.

```sh
pnpm screenshots                       # writes docs/img/screens/
OUT=/tmp/shots pnpm screenshots        # somewhere else
VERBOSE=1 pnpm screenshots             # with the API, web and helper logs
SERVE=1 pnpm screenshots               # keep the stack up afterwards, until Ctrl+C
ONLY=rooms pnpm screenshots            # only the room, voice, chat and player shots
SHOTS_API_PORT=8803 SHOTS_WEB_PORT=5193 pnpm screenshots   # other ports
CHROME=/path/to/chrome pnpm screenshots
```

The README header and the GitHub social preview are drawn from `scripts/readme-header.html` and
`scripts/social-preview.html` with the hfps-visuals renderer:

```sh
R=.claude/skills/hfps-visuals/assets/render.mjs
node $R scripts/social-preview.html docs/img/social-preview.png .stage 1360
node $R scripts/readme-header.html docs/img/readme-header-light.png .light 1360
node $R scripts/readme-header.html docs/img/readme-header-dark.png .dark 1360
```

## Rebuilding the app icon

The icon is drawn in the Designer (`scripts/glyph.designer.json`, name "Openlive app icon"; open it
in the Designer (File, Open project file) and save back in place). Everything else is rebuilt from it:

```sh
DESIGNER="github:henriquefps/logo-designer#c4d17a026120"
bunx --bun "$DESIGNER" to-svg scripts/glyph.designer.json --glyph -o scripts/glyph.svg   # then re-add the one-line comment header
bunx --bun "$DESIGNER" icons scripts/glyph.designer.json -o /tmp/icons --site /tmp/icons/site --tile '#5b7a3a'
# copy /tmp/icons/docs-img/* to docs/img, /tmp/icons/site/* to apps/web/public,
# ios/AppIcon.appiconset/AppIcon-1024.png to apps/mobile/assets/icon.png,
# android/res/mipmap-xxxhdpi/ic_launcher_foreground.png (resized to 512) to apps/mobile/assets/adaptive-icon.png,
# docs/img/icon.svg to packaging/linux/icons/dev.hfps.OpenliveHelper.svg (and into packaging/macos/AppIcon.svg)
```

Then update by hand what embeds the glyph: `apps/web/src/components/AppMark.tsx`, the paths in
`helper/internal/tray/icons.go`, and re-render the README header and social preview (above).
