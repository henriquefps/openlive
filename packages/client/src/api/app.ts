// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AppTokenRequest,
  AppTokenResponse,
  AppWsTicketResponse,
  InstanceInfo,
} from '@openlive/protocol';
import type { ApiClient } from './client.ts';

// The mobile app's side of its login and sockets (docs/PROTOCOL.md 11.6): the instance
// description, the code-for-token exchange, signing out, and the single-use socket tickets.

export const APP_CLIENT = 'openlive-mobile';
export const APP_REDIRECT_URI = 'openlive://auth';

/** GET /.well-known/openlive.json: public, the same for everyone. */
export const instanceInfo = (api: ApiClient) => api.get<InstanceInfo>('/.well-known/openlive.json');

/** POST /api/app/token: the one-time code and the PKCE verifier for an app token. */
export const exchangeAppToken = (api: ApiClient, request: AppTokenRequest) =>
  api.send<AppTokenResponse>('POST', '/api/app/token', request);

/** DELETE /api/app/token: the app signs itself out (its token is revoked). */
export const revokeAppToken = (api: ApiClient) => api.send('DELETE', '/api/app/token');

/** POST /api/app/ws-ticket: a ticket for one socket upgrade, valid 60 s (socket/urls.ts). */
export const wsTicket = (api: ApiClient) =>
  api.send<AppWsTicketResponse>('POST', '/api/app/ws-ticket');
