# Why Cloudflare

Openlive runs entirely on Cloudflare: the Realtime SFU and TURN carry the media, one Worker with
Durable Objects runs the API and the rooms, D1 holds the accounts, R2 the thumbnails and helper
builds, and Analytics Engine the metrics. That is a deliberate choice, not an accident of the first
prototype. This page says why, what the choice costs, and what keeps it from being a trap.

Prices and quotas below were checked when this page was written (October 2026) and change over
time; the setup and the admin overview read the live figures where they can.

## The short answer

For a private group of friends streaming games to each other, Cloudflare is the only place where
the whole product (media server, TURN, API, real-time state, database, storage) is **managed, in
one account, and free in normal use**, on a network that is close to the people watching. Every
alternative gives up at least one of those.

## The reasons

### 1. Free where it matters: media bandwidth

For streaming, the bill is the bandwidth leaving the media server. Cloudflare Realtime gives
**1,000 GB of egress a month free per account**, then US$ 0.05 per GB, and what the helper sends
to Cloudflare costs nothing. A 1080p60 stream at 8 Mbit/s to three friends, three hours a day, is
about 1 TB a month: inside the free tier. Each self-hosted instance lives in its own account, so
each group gets its own free quota and nobody pays for anyone else's bandwidth
([self-host.md](self-host.md)).

The rest of the stack fits the free plans too: Workers, Durable Objects, D1 and R2 all have free
tiers that a group of friends stays inside. Workers Paid (US$ 5 a month) raises those to monthly
included quotas and turns the hard daily caps into small metered overage, if a group ever wants
headroom.

### 2. Zero operations

There is no server to patch, no certificate to renew, no UDP port range to open, no TURN server
to run, no database to back up and no process to restart at 3 a.m. `pnpm run setup` creates
everything and deploys; running it again updates. This is what makes "host your own Discord
alternative" realistic for someone who is not a sysadmin, which is the point of the project.

### 3. A global network, close to every viewer

The SFU is anycast: each person connects to the nearest Cloudflare location, and Cloudflare's own
backbone carries the media between locations. Friends in different cities, or countries, each get
a short first hop. A single server in one city cannot do that, and for real-time media the
distance shows up directly as latency (about 100 ms glass-to-glass today,
evidence.md).

### 4. Everything in one place

The media server, TURN, compute, real-time state, SQL database, object storage, metrics, DNS and
the custom domain live in one account, under one login, one token and one bill. Durable Objects in
particular fit the product's shape: one object per room that owns who is here, who is live and who
holds a viewer slot, with its WebSockets attached, so there is no Redis, queue or sticky-session
load balancer to add.

### 5. A large, durable company

Cloudflare is a large public company whose core business is this network; Realtime, Workers, D1
and R2 are general-availability products used well beyond Openlive. For a project that asks
groups to put their friends' streams on it, that matters more than shaving a few dollars.

## The alternatives we looked at

| Option                                   | Cost for a group                     | What it gives up                                                                                           |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Cloudflare (chosen)**                  | US$ 0 (or US$ 5 with Workers Paid)   | —                                                                                                          |
| Oracle Cloud Always Free VM              | US$ 0, with ~10 TB of egress a month | You run everything (SFU, TURN, OS updates); one region; free VMs can be reclaimed                          |
| A VPS (Hetzner, Vultr, Magalu, …)        | about US$ 5–10 a month               | You run everything; one city; cheap regions are often far from the viewers                                 |
| AWS / GCP / Azure                        | egress around US$ 0.09–0.15 per GB   | Many times the bandwidth price, and you still run the SFU                                                  |
| Managed SFU (LiveKit Cloud, Daily, IVS…) | per participant-minute or per GB     | Usually costlier than Cloudflare at this use, and the rest of the stack (API, state, database) is separate |
| A server at home                         | your electricity                     | Limited by your upload speed, CGNAT, your PC must stay on                                                  |

The only other free option is a free VM, and it is free only in money: it trades the bill for the
work of running a media server.

## What the choice costs

- **Lock-in where it is hard to avoid.** The SFU integration (`apps/api/src/rtc/`) and the three
  Durable Object classes are Cloudflare-specific.
- **Free-tier limits are daily hard caps.** On Workers Free, going over a daily limit stops the app
  until 00:00 UTC. On 2026-10-28 the Durable Objects SQLite limit (100,000 rows written a day) did
  exactly that, because the rooms wrote far more than they needed to (a web tab left open on a
  stream wrote about 34,000 rows a day). The fix
  cuts those writes by more than ten times (a group of five streaming and talking 3 hours a day now
  writes about 1,600 rows a day), keeps them under budgets that CI checks for every free limit the
  app can reach, and adds a "Cloudflare limits" panel to the admin overview: today's use of each
  free limit on Workers Free, or the month's use against the included amounts and the overage on
  Workers Paid (the plan is detected from the account or chosen there). If a limit is reached
  anyway, the app says so and waits for 00:00 UTC instead of reconnecting in a loop.
- **Cloudflare decides prices and terms.** If they change, every instance is affected.

## What keeps it from being a trap

- **The helper knows nothing about Cloudflare.** It talks to the Openlive API and does plain WebRTC
  with pion; the API mediates the SFU. Moving the media server would not touch the streamer's side.
- **Most of the backend is portable.** The API is Hono, which also runs on Node, Bun and Deno; D1 is
  SQLite, so the schema and queries carry over; R2 speaks the S3 API.
- **The hard part is small and isolated.** Of about 16,000 lines in the API, the SFU code and the
  Durable Object classes are the pieces another host would need replaced (for example by
  mediasoup or LiveKit, and an in-process room object over SQLite).
- **It is open source (AGPL-3.0).** Anyone who needs another host can build that backend.

We would revisit this if a typical group regularly went past the free bandwidth, if Cloudflare's
prices or terms changed for the worse, or if the community needed a host outside Cloudflare.
