// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import pkg from '../package.json';
import { api } from './api';
import { hubSocket } from './hub/route';
import { sameOrigin } from './auth/origin';
import { ApiError, doQuotaResponse, errorResponse, isDoQuotaError } from './errors';
import { errorMetrics } from './metrics/errors';
import { metricsDataset } from './metrics/points';
import { roomSocket } from './room/route';
import { securityHeaders } from './security/headers';
import { spaceSocket } from './space/route';
import { wellKnown } from './well-known';
import { scheduled } from './usage/scheduled';

export { RoomDO } from './do/room';
export { SpaceDO } from './do/space';
export { UserHubDO } from './do/user-hub';

const app = new Hono<{ Bindings: Env }>();

// CSP, framing, HSTS and the rest on every Worker response (security/headers.ts); first, so it
// also covers error answers.
app.use('*', securityHeaders);
// Error counts per code into Analytics Engine; registered first, so it sees them all.
app.use('/api/*', errorMetrics(metricsDataset));
// CSRF: every state-changing /api request must come from the app's own origin.
app.use('/api/*', sameOrigin);

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    version: pkg.version,
    commit: c.env.APP_COMMIT || 'dev',
    builtAt: c.env.APP_BUILT_AT || null,
  }),
);
app.get('/.well-known/openlive.json', wellKnown);
app.get('/ws/rooms/:roomId', roomSocket);
app.get('/ws/hub', hubSocket);
app.get('/ws/spaces/:spaceId', spaceSocket);
app.route('/api', api);

app.notFound((c) => errorResponse(c, 404, 'not_found'));
app.onError((err, c) => {
  if (err instanceof ApiError) return errorResponse(c, err.status, err.code, err.params);
  if (isDoQuotaError(err)) {
    console.error('Durable Objects free-tier limit reached', err);
    return doQuotaResponse(c);
  }
  console.error(err);
  return errorResponse(c, 500, 'internal_error');
});

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
