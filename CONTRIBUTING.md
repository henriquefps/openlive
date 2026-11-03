# Contributing to Openlive

Thanks for your interest. Openlive is a small project run by one maintainer, so the most helpful
contributions are focused: a bug report with the `openlive-helper doctor` output, a fix with a
test, or an idea discussed in an issue before a large pull request.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go
through [SECURITY.md](SECURITY.md), never a public issue.

## Run it locally

You need Node 26 (`.nvmrc`), pnpm 12.15 (`corepack enable`), and, for the helper, Go 1.27 and
GStreamer 1.26 or newer with its development files.

```sh
pnpm install
pnpm --filter @openlive/api dev    # the Worker on :8790 (wrangler dev, local D1)
pnpm --filter @openlive/web dev    # Vite on :5179
```

No Cloudflare account is needed for this: `wrangler dev` runs the Worker, its Durable Objects and
D1 locally. Streaming through the real SFU needs Realtime credentials of your own in
`apps/api/.dev.vars` (never commit it).

- [apps/web/README.md](apps/web/README.md): the design system, localization and the web tests.
- [helper/README.md](helper/README.md): building the helper, its build tags, and the local
  end-to-end loop with a real stream.
- [docs/self-host.md](docs/self-host.md): deploying a full instance to your own account.
- [README.md](README.md#project-layout): where everything lives.

Before you push, run what CI runs:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check   # pnpm format fixes it
pnpm i18n:check     # every string in English and Brazilian Portuguese
pnpm spdx:check     # the license line in every source file; pnpm spdx:fix adds it
pnpm notices --check  # THIRD_PARTY_NOTICES matches the dependencies; pnpm notices rewrites it
(cd helper && go test ./... && golangci-lint run)   # -tags=nogst without GStreamer
```

## Conventions

- **English** in everything that enters the repository: code, identifiers, comments, logs,
  commit messages, pull requests and docs.
- **Localized interface.** No user-visible text as a literal in JSX: strings live in
  `packages/client/locales/` (shared by the web and the app) in English and Brazilian Portuguese
  . The API returns error codes
  with parameters (`{ "code": "stream_permission_required" }`) and the web translates them.
- **Permissions through `can()`.** Every access decision in the API goes through
  `can(actor, action, resource)` in [`apps/api/src/auth/can.ts`](apps/api/src/auth/can.ts), never
  an ad-hoc role check.
- **Protocol first.** A change to what travels between the web, the API and the helper starts in
  [`packages/protocol/schema`](packages/protocol/schema) and
  [docs/PROTOCOL.md](docs/PROTOCOL.md) (with a version bump), then `pnpm --filter
@openlive/protocol generate` regenerates the TypeScript and Go types. Never edit the generated
  files.

- **License header.** Every source file starts with `SPDX-License-Identifier: AGPL-3.0-only` in
  a comment; `pnpm spdx:fix` adds it.
- **Tests** with the change: Vitest for the TypeScript (the Worker tests run in workerd), `go test`
  for the helper.
- Dependencies are pinned to exact versions and must be compatible with the AGPL-3.0 (MIT,
  Apache-2.0, BSD, ISC, LGPL with dynamic linking).

## Developer Certificate of Origin

Openlive uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO), not
a CLA. You keep the copyright of your
contribution and license it under the AGPL-3.0, like the rest of the project. By adding a
`Signed-off-by` line to a commit you certify the following:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Sign off every commit with `git commit -s`, which adds a line with your `user.name` and
`user.email`:

```
Signed-off-by: Your Name <you@example.com>
```

Sign-offs and commit metadata become public, so we recommend your GitHub noreply address
(`<id>+<login>@users.noreply.github.com`, under GitHub's e-mail settings) as `user.email` for this
repository. A check on every pull
request fails when a commit lacks the line; fix it with `git commit --amend -s` for the last commit
or `git rebase --signoff main` for all of them, then force-push the branch. Commits made before the
DCO was adopted (2026-10-28) are not signed off; the check only looks at new pull requests.

## Pull requests

1. For anything larger than a small fix, open an issue first so the approach can be agreed.
2. Branch from `main`, keep the change focused, and add or update the tests and docs it touches.
3. Run the checks above, sign off your commits, and open the pull request against `main` using
   the template.
4. CI (TypeScript, Go, DCO) must pass. The maintainer reviews, may ask for changes, and squashes
   on merge.
