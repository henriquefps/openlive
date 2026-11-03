// SPDX-License-Identifier: AGPL-3.0-only
import { cookieSession, createApiClient } from '@openlive/client';

// The web's API client (@openlive/client, api/client.ts): same-origin requests with the session
// cookie; the browser adds Origin to the ones that change state, which the API checks (CSRF).

export { ApiError, errorBodyOf } from '@openlive/client';

export const webApi = createApiClient({ auth: cookieSession() });

export const apiGet = webApi.get;
export const apiSend = webApi.send;
export const apiUpload = webApi.upload;
