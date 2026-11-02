# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**, never in a public issue, pull request or discussion:

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private
   vulnerability reporting, which creates a draft security advisory only the maintainer sees).
2. Describe the problem, the affected component and version (commit, or `openlive-helper
version`), how to reproduce it, and the impact you expect.

If you cannot use GitHub's form, e-mail contact@hfps.dev with "Security" in the subject.

You should get an answer within a week. Once a fix is ready it is released, the advisory is
published, and you are credited unless you prefer otherwise. Please give us a reasonable time to
fix the problem before disclosing it.

## Supported versions

Openlive is self-hosted and has no long-term support branches yet. Fixes land on `main` and in
the next helper release; self-hosters update by running the setup again
([docs/self-host.md](docs/self-host.md#update)).

| Component         | Supported                      |
| ----------------- | ------------------------------ |
| Web app and API   | `main`                         |
| `openlive-helper` | The latest `helper-v*` release |

## Scope

In scope, in this repository:

- **The API Worker** (`apps/api`): sign-in (Discord, magic link), sessions, invites, roles and the
  `can()` permission checks, the room WebSocket and Durable Objects, the SFU and TURN proxy, the
  usage and cost brakes.
- **The web app** (`apps/web`): cross-site scripting, leaking another user's data or streams,
  bypassing room or stream permissions.
- **The helper** (`helper/`): device pairing and token storage, anything that captures or sends
  more than the user chose (another window, the whole screen, audio of another app).
- **The protocol** (`packages/protocol`) and the self-host setup (`scripts/setup`), for example a
  secret written where it should not be.

Out of scope:

- Cloudflare's own platform (Workers, Durable Objects, D1, R2, Realtime): report those to
  Cloudflare.
- A self-hosted instance's own configuration, accounts or domain, unless the setup or the docs
  caused the problem.
- Denial of service by volume against an instance (the cost brakes limit the bill, not the
  traffic), and spam of sign-in e-mails within the rate limits.
- Vulnerabilities in dependencies with no demonstrated impact on Openlive; report them upstream.

What Openlive does not claim: streams are not end-to-end encrypted yet
; media is encrypted in transit
(DTLS-SRTP) and passes through Cloudflare's SFU.
