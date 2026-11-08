# Observability

What each part measures, where it goes and how the status pages read it back.

## Where the numbers come from

| Source              | What                                                                                                                                                                                                                     | How often                                                                                                 | Code                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Viewer (web player) | Time to first frame (click → first presented frame) and how the watch began (on the click or from a hover pre-pull), freezes, fps, bitrate, loss, frames dropped, playback errors, reconnects, RTT, jitter buffer, layer | `getStats()` every second, summed and posted every 30 s and when the watch view closes                    | `apps/web/src/player/metrics.ts` → `POST /api/metrics/viewer`        |
| Helper (`run`)      | fps captured and sent, target and sent bitrate, CPU (the helper process, % of a core), loss, RTT, PLIs + FIRs, largest keyframe, encoder                                                                                 | `helper.stats` every second; the user hub writes one point per stream every 30 s and when the stream ends | `helper/cmd/openlive-helper/live.go` → `apps/api/src/do/user-hub.ts` |
| Room (`RoomDO`)     | Each stream that ends: its duration and reason; a helper that vanished counts as a drop                                                                                                                                  | Once per stream                                                                                           | `apps/api/src/do/room.ts` (`endStream`)                              |
| Durable Objects     | Each circuit breaker trip: the object class and id, what tripped and the counts; also one `console.error`                                                                                                                | Once per trip (an object stays tripped 10 minutes; a socket is closed)                                    | `apps/api/src/do/breaker.ts`                                         |
| Worker              | Every `/api` response with status ≥ 400: its code, status and method, under the space when the route knew it                                                                                                             | Per error, at most 120 a minute per isolate                                                               | `apps/api/src/metrics/errors.ts`                                     |

The Cloudflare limits (Workers, Durable Objects, D1) are read by the limits monitor every 5
minutes from the GraphQL Analytics API, stored in D1 (`platform_settings` `limits_snapshot`) and
shown in the admin's Limits brake card; the platform admins get an e-mail at 50 %, 70 % and the
brake's share, once a day each, and the brake pauses the instance at its share
(`apps/api/src/usage/limits-monitor.ts`). On
Workers Paid, also turn on Cloudflare's billing usage notifications.

The usage meter (egress, viewer and stream minutes per day for the quota) is separate and stays in
D1 (`usage_daily`); these metrics are for quality, not billing.

## Workers Analytics Engine

Everything goes to one dataset, `openlive_metrics` (binding `METRICS`, in `wrangler.jsonc` for dev
and `env.production`). Analytics Engine needs no setup: the dataset is created by the first write,
and the self-host setup creates nothing for it.

Limits that matter here (Cloudflare's documentation, checked on 2026-10-27):

- **Price:** Workers Free includes 100,000 data points written and 10,000 read queries **a day**;
  Workers Paid 10 million points and 1 million queries a month, then US$ 0.25 per million points
  and US$ 1 per million queries. **Billing is not active yet.**
- Per point: 20 blobs (16 KB in all), 20 doubles, one index (96 bytes); 250 points per Worker
  invocation. Data is kept for **3 months**.
- Budget: a viewer writes 120 points an hour, a live helper 120 an hour. The free 100,000 a day is
  ~800 viewer-hours a day, far above a group of friends. A status page load costs 7 queries (the
  admin's 14), cached for a minute in the Worker.

### Point layout

Every point: `index1` = space id (`instance` when there is none; the sampling key), `blob1` = kind,
`blob2` = space id, `blob3` = room id, `blob4` = stream id (empty when not known). The rest, per
kind (`apps/api/src/metrics/points.ts` is the source of truth):

| Kind      | blobs                                                                                                                                                          | doubles                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewer`  | 5 layer, 6 start (`click`/`prepull`)                                                                                                                           | 1 window s, 2 watch s, 3 TTFF ms, 4 has TTFF (0/1), 5 freezes, 6 fps, 7 bitrate kbps, 8 loss %, 9 frames dropped, 10 playback errors, 11 reconnects, 12 RTT ms, 13 jitter buffer ms |
| `helper`  | 5 encoder                                                                                                                                                      | 1 window s, 2 reports, 3 captured fps, 4 sent fps, 5 target kbps, 6 sent kbps, 7 CPU %, 8 loss %, 9 RTT ms, 10 keyframe requests, 11 largest keyframe bytes                         |
| `stream`  | 5 end reason                                                                                                                                                   | 1 duration s, 2 dropped (0/1)                                                                                                                                                       |
| `error`   | 5 method, 6 code                                                                                                                                               | 1 HTTP status                                                                                                                                                                       |
| `breaker` | 5 object class, 6 object id (room or space; empty for a user hub), 7 cause (`alarm`/`request`/`message`/`total`/`socket`), 8 window (`minute`/`hour`/`second`) | 1 alarms, 2 requests, 3 messages (in the window that tripped), 4 cool-down s (0 for a socket)                                                                                       |

No names, e-mail addresses, IPs or user ids are written: only space, room and stream ids, which
are random, and numbers.

## Status pages

- **Space status** (`/s/<space>?tab=status`, owners and admins; `GET /api/spaces/:id/status?range=24h|7d`):
  median and 90th percentile TTFF (and each split by click or pre-pull), freezes per hour,
  reconnects, viewer minutes, dropped streams over ended streams, the helpers' fps, bitrate, CPU,
  keyframe requests per hour and largest keyframe, the top 5 error codes, and the Durable Object
  circuit breaker trips by object class and cause.
- **Admin** (`/admin`, platform admin; `GET /api/admin/status?range=24h|7d`): the same for the
  whole instance, plus a row per space.

The Worker reads the dataset through the Analytics Engine **SQL API**
(`POST /client/v4/accounts/<account>/analytics_engine/sql`) with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, the secrets the usage cron already uses. The token needs **Account >
Account Analytics > Read**, the permission the cron already needs, so a working usage meter means a
working status page. Without the secrets the page says which are missing; with a token that lacks
the permission it names the permission; if the API fails it says to try again. Writing never
depends on any of that.

Every count is weighted by `_sample_interval`, so it stays right if Analytics Engine samples.

## Locally

`wrangler dev` keeps Analytics Engine local and unreadable. Set `METRICS_LOG=1` in
`apps/api/.dev.vars` and every point is also logged as `metrics {...}` in the `wrangler dev`
terminal (or in Workers Logs, deployed). The status page needs the real SQL API, so locally it
shows "needs a Cloudflare API token" unless you give it one.
