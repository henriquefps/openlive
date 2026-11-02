# README screenshots

`pnpm screenshots` takes the gallery of the root README (`docs/img/screens/`) from the real web
app, against a local instance with fictional data. Run it again after a UI change and commit the
images.

What it does, in order (`src/main.ts`):

1. Applies the D1 migrations to a throwaway state directory and starts `wrangler dev` on
   **:8799** (with `DEV_AUTH=1` and a random `SESSION_SECRET`) and Vite on **:5188** (or
   `SHOTS_API_PORT`, `SHOTS_WEB_PORT`). It stops if
   either port is taken, and stops both (and everything else it started) at the end.
2. Seeds made-up users (Ana, the platform admin; Bruno; Carla; Diego) straight into the local D1,
   then the space "Friends" with the rooms "Movie night" (stream, voice, cameras, text), "Games"
   (stream), "Hangout" (voice with cameras) and "General" (text), the invites, a second space and
   a month of estimated usage through the API as those users.
3. With the dev Realtime credentials, builds the helper, pairs two copies, and has Bruno publish
   the synthetic test pattern (`test-stream`) while Ana's waits for **Go live** (`run
--test-source`). Without them, the room, player and Go live shots are skipped.
4. Drives headless Chrome (`playwright-core` with the installed Google Chrome, with its fake
   microphone and camera) through each screen in light and dark at 1440 px, and a few at 390 px,
   and writes palette PNGs with `sharp`. In the rooms, Bruno and Diego join voice (Bruno on
   camera) and write in the chat; Carla, in voice too, is the one on screen.

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
