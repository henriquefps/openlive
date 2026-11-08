# Self-hosting Openlive

Each group runs Openlive in **its own Cloudflare account**. Every instance gets its own free
Realtime quota (1,000 GB of egress a month), and nobody else pays for your bandwidth. This guide is
a checklist: do the boxes in order and you end with a running instance, your admin account and a
first invite.

One Worker serves everything: the web app as static assets, the REST API under `/api/*` and the
room WebSocket under `/ws/*`, with D1 for data, Durable Objects for rooms, a private R2 bucket for
thumbnails and the helper downloads, Analytics Engine for metrics, and Cloudflare Realtime (SFU and TURN) for media.

You never edit a file of the repository. Everything that makes the instance yours lives in
git-ignored files under `apps/api/`, written by the setup:

| File                             | What                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `.instance.<env>.json`           | Worker name, address, e-mail sender, resource names and ids. No secrets.         |
| `.secrets.<env>` (mode 0600)     | The secrets, uploaded with every deploy.                                         |
| `wrangler.<env>.generated.jsonc` | The committed template (`env.production` in `wrangler.jsonc`) with the above in. |

`<env>` is a local name for the instance, `production` by default (`--env`). One clone can deploy
several instances, each with its own `--env`.

---

## 1. Before you start

- [ ] **A Cloudflare account** (<https://dash.cloudflare.com/sign-up>). The free plan is enough for
      Workers, Durable Objects, D1 and Analytics Engine.
- [ ] **Card or not.** Decide now, because R2 asks:
  - **R2 needs an R2 subscription.** It costs $0 within its free tier, but enabling it asks for
    a payment method. Without R2 there is no instance today.
  - **Realtime** has no plan and is **never blocked** by Cloudflare: above the free 1,000 GB a
    month it bills $0.05/GB to the card on file. Openlive keeps the card on purpose and brakes in
    the app instead: you pick a monthly limit, it warns at 70 %, 90 % and 100 %, and by default
    blocks new streams at 100 % (see [Costs](#7-costs-in-plain-words) below).
- [ ] **An address**, one of:
  - **A domain of yours** whose zone is in the same Cloudflare account and **active** (dashboard
    → your domain → Overview says _Active_). Any subdomain works, e.g. `live.example.com`.
  - **A free workers.dev address**, `<name>.<your-subdomain>.workers.dev`. Open _Workers & Pages_
    in the dashboard once so the account gets its subdomain. No domain needed; e-mail login then
    needs a domain verified in Resend anyway (below), so Discord is the easy login here.
- [ ] **At least one login method** (both is best). You create the keys during the setup, which
      prints the exact values to paste, but have the accounts ready:
  - **Discord:** a Discord account, for an application at
    <https://discord.com/developers/applications>.
  - **E-mail (magic link):** a [Resend](https://resend.com) account and a domain you can add DNS
    records to. Resend only sends to people other than you from a **verified domain**.
- [ ] **Node 26 and pnpm 12.15**: install Node from <https://nodejs.org>, then `corepack enable`.
- [ ] **This repository**, and its dependencies:

  ```sh
  git clone https://github.com/henriquefps/openlive.git && cd openlive
  pnpm install
  ```

## 2. Log in to Cloudflare (twice)

The setup drives two pinned CLIs: wrangler for D1, R2 and the deploy, and `cf` for the Realtime
app and TURN key, which wrangler's login cannot create.

```sh
pnpm --filter @openlive/api exec wrangler login
pnpm --filter @openlive/setup exec cf auth login
```

- [ ] Both open the browser; accept with the account that will run the instance.

## 3. Check, then look at the plan

```sh
pnpm run setup -- --domain live.example.com --check     # or: --workers-dev openlive
```

> It is `pnpm run setup`, with `run`. A bare `pnpm setup` is pnpm's own command (it configures
> pnpm's home directory) and never reaches Openlive's setup.

`--check` runs the checks below and stops. They only read; nothing is created:

```text
Checks:
  [ok] Node.js: 26.12.1
  [ok] pnpm: 12.15.0
  [ok] Dependencies: installed
  [ok] wrangler login: 1 account(s)
  [ok] cf login (Realtime): logged in
  [ok] R2 enabled: enabled
  [ok] Zone for live.example.com: example.com is active
```

Each failed check (`[XX]`) prints a `fix:` line with what to do: install Node, `corepack enable`,
`pnpm install`, one of the two logins, enable R2 (dashboard → R2 Object Storage, card asked
once), add the domain to the account or finish its nameserver change, or pick the workers.dev
subdomain. With several accounts on one login, add `--account-id <id>` (the setup lists them).

Then the plan. `--dry-run` calls nothing and writes nothing:

```sh
pnpm run setup -- --domain live.example.com --dry-run
```

```text
Plan:
   1. [>] Check the login: wrangler whoami (and cf auth whoami for Realtime)
   2. [=] Address https://live.example.com (custom domain)
   3. [~] Write apps/api/.instance.production.json
   4. [~] Create apps/api/.secrets.production from .secrets.example (mode 0600)
   5. [?] Set up login (Discord, e-mail or both)
   6. [*] D1 database openlive
   ...
  [+] create  [*] create if missing  [=] keep  [~] write locally  [>] run  [?] question
```

- [ ] No `Errors` section in the plan.

Options worth knowing: `--name <worker>` (Worker name with `--domain`; default `openlive`, or
`openlive-<env>` for another `--env`), `--email-from "Openlive <login@example.com>"` (default with
`--domain`: `login@` that domain), `--env <name>` for a second instance, `--no-metrics` to deploy
without the Analytics Engine binding, `--log-sampling <0..1>` for the share of invocations Workers
Logs keeps (default 0.1, see [Workers Logs](#workers-logs) below), `--yes` to skip the
confirmations (and the questions: then the keys must already be in the secrets file).

## 4. Run the setup

```sh
pnpm run setup -- --domain live.example.com
```

It asks before each step that creates something or deploys. What each step does and prints:

1. **Checks** as above. Then **the plan**, with the account.
2. **Address.** Taken from `--domain` / `--workers-dev`. Without them it asks: _1. a domain of
   yours, 2. a workers.dev address_. It is stored in `.instance.<env>.json`, so later runs never
   ask again.
3. **Login** (the secrets assistant), when the secrets file has no login method yet:
   _1. Discord 2. E-mail 3. Both_.
   - **Discord.** It prints the exact redirect to add, for your address:

     ```text
     2. OAuth2 → Redirects → add exactly:
          https://live.example.com/api/auth/discord/callback
     ```

     Create the application, add that redirect, **Save Changes**, then paste the Client ID and
     the Client Secret (_Reset Secret_ shows it once). The setup checks the pair with Discord
     (a client-credentials request; nobody signs in) and asks again if Discord refuses it.

     <!-- screenshot: discord-oauth-redirects -->

   - **E-mail.** In Resend: _API Keys → Create API Key_ with **Sending access**, and _Domains →
     Add Domain_ with the sender's domain (the setup names it). Add the DNS records Resend shows
     in the Cloudflare dashboard of that zone and wait for **Verified**. Paste the key: the setup
     checks it without sending anything (a send-only key answers `restricted_api_key` to a
     read, which proves it is real; a full-access key also lets it check that the sender's
     domain is verified).

     <!-- screenshot: resend-api-key-sending-access -->
     <!-- screenshot: resend-domain-verified -->

   - **Analytics token (optional).** Real Realtime egress in the in-app meter instead of the
     estimate. Dashboard → _My Profile → API Tokens → Create Token → Custom token_, permission
     **Account → Account Analytics → Read**, this account only. The setup verifies the token and
     reads one row of usage with it. Enter skips it.

     <!-- screenshot: cloudflare-analytics-token -->

   Pasted values are never shown, not even as dots, and go straight into
   `apps/api/.secrets.<env>` (mode 0600). Prefer editing that file? Fill in `DISCORD_CLIENT_ID`
   and `DISCORD_CLIENT_SECRET` and/or `RESEND_API_KEY` (and optionally `CLOUDFLARE_API_TOKEN`)
   and run again; the assistant only asks for what is missing.

4. **D1 database** and **`wrangler.<env>.generated.jsonc`** (the template with your account and
   database ids).
5. **R2 bucket** (private: no public URL).
6. **Realtime SFU app and TURN key.** Cloudflare shows their tokens only once, so they go straight
   into the secrets file and are never printed.
7. **`SESSION_SECRET`, `INSTALL_CODE`** generated, **`CLOUDFLARE_ACCOUNT_ID`** stored.
8. **Key check.** The login keys and the analytics token are checked again; a refused key stops
   here, before anything is deployed.
9. **Build** the web app, **apply the D1 migrations** remotely.
10. **Deploy** with `wrangler deploy --secrets-file`: code and secrets go up as **one version**,
    so no version without secrets ever takes traffic. With a custom domain the same deploy
    attaches the domain and its DNS record and certificate.

It ends with:

```text
Openlive is deployed: https://live.example.com
Sign in at https://live.example.com

Install code (shown once; sign in and enter it to become the admin): 7K2Q-M9XD-4RTB
Claim it now: until then, anyone who finds the address can sign up.
```

- [ ] You have the install code. Lost it? It is `INSTALL_CODE` in `apps/api/.secrets.<env>`.

**If a step fails**, the setup lists what that run already did and stops. Nothing is lost:
run the same command again. It finds what exists (from the account and from
`.instance.<env>.json`), creates only what is missing, and never creates a second database,
bucket, Realtime app or TURN key. Never add `DEV_AUTH` to the secrets file: the setup refuses to
deploy it.

## 5. First login, install code, onboarding, first invite

- [ ] Open the address. A brand-new custom domain can take a few minutes to resolve (see
      [Troubleshooting](#9-troubleshooting)).
- [ ] **Sign in** with Discord or the e-mail link.
- [ ] **Claim the instance**: _Claim it with the install code_ (`/admin/claim`), enter the code.
      The first account to do so becomes the platform admin.
      **Do this right after the first deploy.** Until the instance is claimed, sign-up is open:
      anyone who finds the address can create an account (so that you can create yours). They
      cannot become admin without the install code, and once you claim the instance it is
      invite-only, but accounts made before that stay; check `/admin/users` after claiming
      (L5).
- [ ] **Onboarding** (`/admin/setup`): the checks of the instance (each with ✅ or what is
      missing), the cost calculator, the monthly limit, and your first **space**.

  <!-- screenshot: admin-onboarding-checks -->

- [ ] **Invite people.** New instances are **invite-only**: create an invite link or a quick room
      code in the space and send it. Accounts that exist always sign in. "Who can join" is in
      `/admin/settings`; `/admin/users` lists every account and can sign one out, ban it from the
      instance or delete it with its personal data.

## 6. Install the helper and stream

Viewers need only the browser. Anyone can also go live from a desktop Chromium-based browser
(Chrome, Edge, …) with nothing to install, up to 1080p60: in a room, **Go live**, then **Stream
from the browser**. For excellent quality (up to 4K60 and 120 fps, GPU encoding, only the app's
sound), whoever streams installs the **helper** (Linux and macOS today; Windows later):

- [ ] **Choose the helper version your instance offers** (once per helper version), so members
      can download it from `/download`. From the repository, logged in to wrangler as in step 2:

      ```sh
      pnpm run helper:publish -- --env production --from-release 0.2.0 --dry-run   # the plan only
      pnpm run helper:publish -- --env production --from-release 0.2.0
      ```

      The official builds are public in the project's
      [GitHub Releases](https://github.com/henriquefps/openlive/releases) (`helper-v0.2.0`; with
      `latest` the script picks the newest and writes that version, never "latest", so the helper
      always speaks your server's protocol). The script checks that the Linux tarball, the Flatpak
      and the signed, notarized macOS disk image exist and are listed in the release's `SHA256SUMS`,
      then uploads only `helper/latest.json` to the instance's private bucket: the GitHub URL and
      SHA-256 of each file. Nothing is copied or built (no Flatpak SDK, no Mac) and the files do not
      go through your Worker: `/download` links the browser straight to GitHub. Until you run it,
      `/download` tells the platform admin this command and everyone else that the helper is not
      available yet.

      The Android app (beta) works the same way, from the `android-v<version>` release:
      `--android-from-release 0.1.5`, alone or together with `--from-release`. It writes
      `helper/android.json`, and the Android card on `/download` then shows "Download APK" with the
      SHA-256; without it the card only links to the Android releases. Both flags are read-only on
      GitHub (no token).

      **A fork with its own releases** passes `--release-repo owner/name` and sets the
      `HELPER_RELEASE_REPO` var of the Worker (`apps/api/wrangler.jsonc`, `env.production.vars`) to
      the same value: the Worker serves a GitHub URL only when it is a release asset of that
      repository, over https.

      **Building it yourself** instead (your own build, or changes that have no release yet; the
      files go to your bucket and the Worker serves them to members):
      `pnpm run helper:publish -- --env production --version 0.2.0` builds the tarball (and the
      Flatpak, when `flatpak-builder` is installed) in the Flatpak SDK and uploads them the same
      way ([packaging/linux/README.md](../packaging/linux/README.md#publish-to-an-instance)). A
      macOS build needs a Mac with Xcode and an Apple Developer ID: build the notarized disk image
      there with `packaging/macos/build-app.sh`, copy it into `dist/`, and add
      `--mac-dmg dist/openlive-helper-<version>-macos.dmg`
      ([packaging/macos/README.md](../packaging/macos/README.md)). Without it that build is
      Linux-only and the macOS card says so.

- [ ] Open `/download` on your instance (signed in, as a member of a space): it shows the
      published version with both files, their SHA-256, the install steps and the pairing command
      with your instance's address filled in.
- [ ] Install the **tarball** (`./install.sh`, into `~/.local`) or the **Flatpak**
      (`flatpak install --user openlive-helper-<version>.flatpak`). Details, what works in the
      Flatpak, and the GStreamer requirements of the tarball:
      [packaging/linux/README.md](../packaging/linux/README.md).
- [ ] Pair it: `openlive-helper pair --instance https://live.example.com`, and approve the device
      in the browser. Then start _Openlive Helper_ from the menu (it sits in the tray).
- [ ] On a **Mac**: open the disk image, drag _Openlive Helper_ to Applications and open it; it
      asks for the instance address, pairs through the browser, asks for Screen Recording, and
      stays in the menu bar (and starts at login).
- [ ] `openlive-helper doctor` reports the desktop, GPU, encoders and an encode test. Attach its
      output to any bug report.
- [ ] In a room, **Go live**, pick a screen or window in the desktop's dialog, and stream.

## 7. Costs in plain words

Running Openlive costs **nothing** while your group stays inside Cloudflare's free tiers, which
for most groups means: Realtime under 1,000 GB of egress a month.

- **What uses it:** each viewer watching a stream. Roughly viewers × bitrate × time, plus
  overheads (~1.5× the bitrate and ~15 MB per viewer join). One hour with 6 viewers at
  12 Mbps is ~32 GB by the plain formula, ~49 GB with the overheads: the free tier holds about
  20 to 31 such hours a month.
- **What happens above it:** Cloudflare bills $0.05/GB to the card and does not stop. Openlive
  stops instead, at the **monthly limit you choose** in the admin panel:
  - **Free tier**, 1,000 GB (default, $0);
  - **1,500 / 2,000 / 5,000 GB** (about $25 / $50 / $200 a month at most);
  - **custom** GB (or a monthly dollar amount), or **unlimited**.

  It warns at 70 % and 90 %, turns on economy mode above 90 %, and at 100 % blocks new streams
  (or only alerts, if you choose). Everyone sees a notice once usage passes the free tier.

- **Where to see it:** the onboarding and the admin panel have the **cost calculator** (the same
  formula as the meter, `apps/api/src/usage/calculator.ts`)
  next to the month's real usage (exact with the analytics token, estimated without).

| Product                       | Free each month                                   | Above it                      |
| ----------------------------- | ------------------------------------------------- | ----------------------------- |
| Realtime (SFU + TURN, shared) | 1,000 GB egress                                   | $0.05/GB, **not blocked**     |
| Workers, Durable Objects, D1  | Daily request and row limits (Workers Free)       | Fail until reset (up to 24 h) |
| R2                            | 10 GB-month, 1M Class A, 10M Class B, free egress | Billed (metered subscription) |
| Analytics Engine (metrics)    | 100,000 data points written, 10,000 queries a day | Limited on Workers Free       |
| Workers Logs                  | 200,000 log events a day (Workers Free)           | 1 % kept for the rest of day  |

### Workers, Durable Objects and D1 daily limits

On Workers Free, Cloudflare caps each day's Worker requests, Durable Object requests, duration and
SQLite rows read and written, and D1 rows read and written
([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Normal use
stays far inside them; if one is reached anyway,
rooms and the sidebar stop and everyone sees "This instance hit a Cloudflare daily free limit".
The app then waits instead of retrying: the room socket tries again every 15 minutes, and video
asks nothing of the API for the same 15 minutes.

Cloudflare documents that the daily free limits **reset at 00:00 UTC**, but a block has been seen
to last past it: count on it clearing as the last 24 hours' use
drops below the limit, **up to 24 hours**. Nothing on your side lifts it sooner; Workers Paid
bills the same use instead of refusing it.

The admin's **Cloudflare limits** panel shows each limit for **today (UTC)** and for the **last 24
hours**, with when the figures were read (Cloudflare's analytics lag a few minutes; a window
Cloudflare has no rows for yet says so next to its 0). A figure Cloudflare refuses shows why, with
Cloudflare's own message, and "Raw responses from Cloudflare" under the table shows every query
and its answer: start there if a figure looks wrong.

### The limits brake

Every 5 minutes the instance reads the same figures from Cloudflare and stores them, so the admin
panel shows them without asking Cloudflare.
It needs the analytics token the usage cron already uses (`CLOUDFLARE_API_TOKEN` with Account
Analytics: Read, and `CLOUDFLARE_ACCOUNT_ID`); without them it does nothing.

- **Alerts:** the platform admins get an e-mail (through Resend, like the login link) when a
  limit reaches 50 %, 70 % and the brake's share, each once a day.
- **The brake:** at **80 %** of a limit by default (50 to 95 %, in the admin panel's **Limits
  brake** card), Openlive pauses itself: rooms, spaces and live connections are refused with
  "Paused by this instance's limits brake", and the rooms that were awake close their sockets and
  stop their alarms. Login and the admin panel keep working. It releases at 00:00 UTC, or when you
  press **Release**; **Engage now** pauses the instance by hand.
- **Why below 100 %:** Cloudflare's figures are for your **whole account**. If you run other
  Workers on the same account, a runaway Openlive at 100 % would stop them too; the brake leaves
  them the rest.
- **On Workers Paid** nothing is refused by Cloudflare: use beyond the included amounts is billed,
  and there is no spending cap. Pick a budget in the card: the share of the month's included
  amounts (then it holds until the month turns over) and/or a maximum overage in USD a day. Also
  turn on Cloudflare's own **billing usage notifications** (dashboard → Notifications → Add →
  "Usage Based Billing"), so Cloudflare e-mails you too.
- **Turning it off** keeps the alerts but stops nothing before Cloudflare does; the card warns you.

### Workers Logs

Cloudflare keeps the instance's logs ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)):
one **log event** for every invocation of the Worker or a Durable Object (each request, each
WebSocket message a room or the sidebar receives, each alarm and each cron run) plus one per
`console` line. Workers Free keeps 200,000 a day; past that, Cloudflare keeps only 1 % of the logs
until 00:00 UTC. **Nothing in Openlive stops**: only the logs thin out. Workers Paid includes 20
million a month, then $0.60 a million
([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). From 1 December 2026
Cloudflare moves logs to [volume pricing](https://developers.cloudflare.com/observability/pricing/):
Free 0.5 GB a day (ingestion stops at the limit until 00:00 UTC), Paid 50 GB a month then
$0.25/GB.

The instance logs a **sample**: `head_sampling_rate` 0.1 by default, so one invocation in ten is
kept with all its lines. A busy group's day (about 150,000 events unsampled) then writes about
15,000. Errors are still counted in full by the Worker's own metrics (the status page), and
Openlive logs only warnings and errors, never per message. To change the rate, run the setup again
with `--log-sampling <0..1>` (`1` keeps everything, for a Workers Paid account or while you debug
something; `0` keeps nothing); the instance remembers it in `apps/api/.instance.<env>.json`. The
admin's **Cloudflare limits** panel shows the day's estimate (invocations × the rate) against the
limit.

Price pages: [Realtime](https://developers.cloudflare.com/realtime/sfu/platform/pricing/),
[Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/).

## 8. Keep it running

### Update

```sh
git pull
pnpm install
pnpm run setup -- --yes        # add --env <name> for another instance
```

A new helper version: `pnpm run helper:publish -- --from-release <x.y.z>` (above, step 6), or
`--version <x.y.z>` for your own build. The page offers the one in `helper/latest.json`; builds
uploaded earlier stay in the bucket under `helper/<version>/`. Without a `--version` and without a
`helper-v*` git tag, a build publishes the project version (the root `package.json`).

### Versions

The project version is the root `package.json` `version`; `apps/` and `packages/` carry a copy
(a test fails when one drifts). Bump them together with `pnpm run version:set <x.y.z>`. The Go
helper takes its version when it is built (`helper:publish`).

`GET /api/health` answers `{ ok, version, commit, builtAt }`, and the home page shows
"Server version 0.1.0 (c820e1f)". `pnpm run setup` sets `commit` (the short git commit, with
`-dirty` when tracked files have uncommitted changes) and `builtAt` (an ISO time) as the Worker
vars `APP_COMMIT` and `APP_BUILT_AT` in the generated config; under `wrangler dev` they are `dev`
and empty. Nothing else about the checkout, such as the branch or the author, is sent.

### The mobile app

Nothing to configure. The Worker serves what the Openlive app needs: the instance
description at `/.well-known/openlive.json` (its address, version and protocol range; no personal
data), the app's login (`/app/authorize`, through your usual Discord or e-mail login) and its
tokens. People add your instance in the app by its address, by the QR code in Settings → "Use the
mobile app", or by opening an invite on their phone ("Open in app"). Each phone appears in their
Settings → Sessions as "Openlive app · <device>", where they can revoke it. App tokens never get
the platform admin's powers: administer the instance from a browser.

### Change the address

Run the setup with the new `--domain` or `--workers-dev <same Worker name>`. It notes the change:
add the new Discord redirect, verify the new sender domain in Resend if the sender follows, and
tell your users and helpers (`openlive-helper pair --instance <new address>`). The Worker name is
never changed: a new name is a new instance (`--env`).

### Rotate secrets

Edit the value in `apps/api/.secrets.<env>` and run the setup again; the deploy uploads it with
the code. To change one secret without a deploy, pipe it from stdin so it never shows:

```sh
cd apps/api
printf %s "$NEW_VALUE" | pnpm exec wrangler secret put RESEND_API_KEY \
  --config wrangler.production.generated.jsonc --env production
```

Then update the secrets file too, or the next setup run puts the old value back.

- `SESSION_SECRET`: rotating it signs everybody out.
- `REALTIME_APP_TOKEN`, `TURN_KEY_TOKEN`: Cloudflare can't show them again. Clear both lines of
  the pair, run the setup to create a new one, then delete the old one
  (`pnpm --filter @openlive/setup exec cf realtime sfu apps delete <old-id>`, or
  `cf realtime turn keys delete <old-id>`).
- `INSTALL_CODE`: only matters until the admin account exists.

### Restore the database

Openlive has no backup of its own. D1 Time Travel
restores the database to any minute of the last 7 days on Workers Free (30 on Workers Paid):

```sh
cd apps/api
pnpm exec wrangler d1 time-travel restore DB --timestamp=<RFC 3339 time or Unix timestamp> \
  --config wrangler.production.generated.jsonc --env production
```

### Remove everything

Names below are the defaults; yours are in `apps/api/.instance.<env>.json`.

```sh
cd apps/api
C="--config wrangler.production.generated.jsonc --env production"
pnpm exec wrangler delete $C                       # the Worker, its route and its secrets
pnpm exec wrangler d1 delete openlive $C           # the database
pnpm exec wrangler r2 bucket delete openlive-thumbnails   # empty it first in the dashboard
pnpm --filter @openlive/setup exec cf realtime sfu apps delete <REALTIME_APP_ID>
pnpm --filter @openlive/setup exec cf realtime turn keys delete <TURN_KEY_ID>
rm .secrets.production .instance.production.json wrangler.production.generated.jsonc
```

### Cloudflare features that inject scripts

Some zone features add scripts to every HTML page Cloudflare proxies. Openlive's Content Security
Policy allows only its own scripts (`script-src 'self'`), so the browser would block them and fill
the console with CSP errors. Openlive therefore sends **`Cache-Control: no-cache, no-transform`**
on its HTML (the app's `index.html`, which is also what every deep link gets, and every other
static file but the hashed `/assets/*`), and `no-store, no-transform` on the Worker's own
responses. Cloudflare documents that `no-transform` stops these injections, so you can leave them
on for the rest of the zone:

| Feature                                                                | With `no-transform`                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Web Analytics automatic setup (`beacon.min.js`)                        | Not injected ([docs][wa])                                            |
| JavaScript Detections (Bot Fight Mode, `/cdn-cgi/challenge-platform/`) | Not injected ([docs][jsd])                                           |
| Email Address Obfuscation (`email-decode.min.js`)                      | Not applied ([docs][eo])                                             |
| Rocket Loader                                                          | Not documented either way; same-origin, so the CSP allows its script |
| Compression and Polish                                                 | Turned off for those responses ([docs][cc])                          |

[wa]: https://developers.cloudflare.com/web-analytics/get-started/
[jsd]: https://developers.cloudflare.com/bots/additional-configurations/javascript-detections/
[eo]: https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/
[cc]: https://developers.cloudflare.com/cache/concepts/cache-control/

The last row is why `/assets/*` (the JavaScript and CSS, named by content hash) does not carry
`no-transform`: it gets `public, max-age=31536000, immutable` and Cloudflare keeps compressing
it. The few HTML and small static files that lose edge compression are tiny. The Web Analytics beacon would also send
every visitor's page views to a third party; Openlive has its own metrics (the admin overview and
each space's Status tab).

If you still see CSP errors for `beacon.min.js` or `/cdn-cgi/challenge-platform/` after a deploy:

- The browser or Cloudflare cache holds an older copy of the page: purge the cache and reload.
- A **Transform Rule** (_Rules → Transform Rules → Modify Response Header_) or a **Cache Rule**
  that sets or removes `Cache-Control` on the zone overrides the header. Exclude the Openlive
  hostname from it.
- Web Analytics may also be set up _manually_ (a snippet you pasted into a page): Openlive's pages
  have none, so nothing to do.
- As a last resort, switch the feature off for the zone: Web Analytics → **Manage site** →
  automatic setup **Disable**; Bot Fight Mode off under _Security → Settings_ → **Bot traffic**
  (on the Free plan JavaScript Detections cannot be turned off on its own, and the helper is not a
  browser: it cannot run a challenge). The dashboard labels move from time to time.

The setup does not check these settings: the token it signs in with (wrangler's) cannot read them.

## 9. Troubleshooting

Real problems seen while deploying Openlive, most frequent first.

**Cloudflare API answered 500 / "internal error" in the middle of the setup.** A transient error
on Cloudflare's side. The setup retries its reads by itself; if a create or the deploy failed, it
printed what was already done. Run the same command again: it continues and creates nothing twice.

**The new domain does not open ("server not found"), but the deploy said it is deployed.** The
custom domain's DNS record is new, and your computer or router may still cache "no such name".
Check through Cloudflare's resolver directly:

```sh
curl --doh-url https://cloudflare-dns.com/dns-query https://live.example.com/api/health
```

If that answers `{"ok":true,…}`, the instance is fine and only your local DNS is late: wait a few
minutes, flush the cache (`resolvectl flush-caches` on systemd-resolved), or turn on DNS over
HTTPS in the browser (Firefox: Settings → Privacy & Security → DNS over HTTPS; Chrome: Settings →
Privacy and security → Security → Use secure DNS).

**The browser console shows "Content Security Policy" errors for `beacon.min.js` or
`/cdn-cgi/challenge-platform/`.** Scripts Cloudflare injects, not Openlive's; see
[Cloudflare features that inject scripts](#cloudflare-features-that-inject-scripts).

**Discord says "Invalid OAuth2 redirect_uri".** The redirect in the Discord application is not
exactly `https://<your address>/api/auth/discord/callback`: `https`, no trailing slash, the same
host as the address the setup printed (a workers.dev address includes your subdomain). Fix it
under OAuth2 → Redirects and **Save Changes**; no redeploy needed.

**The magic link e-mail reaches only you, or never arrives.** The sender's domain is not verified
in Resend: until it is, Resend delivers only to the address of the Resend account. Open Resend →
Domains, add the missing DNS records in the Cloudflare dashboard, and wait for **Verified**. The
sender must be on that domain (`--email-from`, or `login@<your domain>` by default). On a
workers.dev address there is no default sender: pass `--email-from` with a verified domain.

**The helper's screen-sharing dialog never shows (Wayland).** The dialog belongs to the desktop
(xdg-desktop-portal), not to the helper.

- Install your desktop's portal backend (`xdg-desktop-portal-kde`, `-gnome`, `-wlr` or
  `-hyprland`) and log out and in.
- A restored source (the web's "Last: …", or `stream` without `--pick`) shares again **without**
  the dialog on purpose. Choose "choose a screen/window" in the web (or `--pick`) to see it.
- It may open behind other windows: check the taskbar.
- `openlive-helper doctor` reports the portal and the desktop it found.

**"cf realtime turn keys create returned no id or token" (fixed).** The first version of the
setup read the TURN key's token from a field `cf` does not return (it is `secret`, as for the SFU
app), so the key was created but its token lost (fixed in #19). If your secrets file has
`TURN_KEY_ID` without `TURN_KEY_TOKEN`, or the setup says they must be set together: update
(`git pull`), clear both lines, run the setup (it creates a new key), then delete the old key
(`pnpm --filter @openlive/setup exec cf realtime turn keys delete <old-id>`).

**`pnpm setup` printed something about `PNPM_HOME` and did nothing.** That is pnpm's built-in
command. Openlive's is `pnpm run setup` (arguments after `--`).

**"env production is the instance of Worker openlive".** You asked for another Worker name
(`--workers-dev other` or `--name other`) in an environment that already has an instance. The
setup never renames a Worker; a second instance needs its own `--env`.

**The deploy fails with wrangler error 10089 (Analytics Engine).** The account has not opted in
to Workers Analytics Engine, which Openlive's metrics use. Turning it on in the dashboard is not
enough by itself: open `https://dash.cloudflare.com/<account id>/workers/analytics-engine`, click
through the Analytics Engine page and **create a dataset** there (any name, on the _Create
Binding_ screen). Only then does the opt-in take effect. Meanwhile the setup deploys without the
metrics binding by itself (it prints that link and "metrics are off until Analytics Engine is
enabled"); everything else works. Run the setup again once it is enabled. `--no-metrics` deploys
without the binding on purpose.

**"R2 is not enabled on this account".** Dashboard → R2 Object Storage → enable it (the card is
asked for once; it stays free within the free tier).

**"the account has no workers.dev subdomain yet".** Dashboard → Workers & Pages: the first visit
asks you to pick the subdomain. Then run the setup again.

---

Screenshots: each `screenshot:` comment above marks an image still to capture. They are taken by a
script, never drawn or edited by hand, so they stay current:
`pnpm --filter @openlive/setup screenshots` lists them and where each comes from (a stub for now,
[scripts/setup/src/screenshots.ts](../scripts/setup/src/screenshots.ts)).
