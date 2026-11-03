# @openlive/client

What the Openlive web app and the mobile app share: TypeScript with no DOM, React or Node APIs, so
it runs in the browser, in React Native and in Node tests. ESLint rejects browser globals, Node
modules and UI libraries in `src/`.

- **REST API client** (`src/api/client.ts`): `createApiClient({ baseUrl, auth, fetch })`. `auth`
  is `cookieSession()` (the web: same origin, the browser's session cookie and Origin header) or
  `bearerToken(() => token)` (the app: `Authorization: Bearer ola_…`, never with a cookie). The
  typed routes (`src/api/*.ts`) take the client as their first argument:
  `listRooms(api, spaceId)`.
- **Sockets** (`src/socket/`, `src/room/`, `src/hub/`, `src/space/`): hello and welcome, ping
  keepalive, reconnect with backoff, and each socket's state. `url` is a string or a function
  called before every connect and reconnect; `ticketSocketUrl(api, socketPaths.room(id))` fetches
  a single-use ticket (`POST /api/app/ws-ticket`) and answers `wss://instance/ws/rooms/id?ticket=…`
  (docs/PROTOCOL.md 11.6). `createSocket` defaults to the platform's `WebSocket`.
- **Chat** (`src/chat/client.ts`): the room chat's state over the room socket.
- **Interface text** (`locales/<language>/translation.json`, as i18next resources from
  `@openlive/client/i18n`). `pnpm i18n:check` keeps every language's keys equal and every protocol
  error code translated.

The web wraps these with its defaults (page origin, app version, React Query) in `apps/web/src`.
Voice, cameras and the WebRTC player stay in the web for now.

```sh
pnpm --filter @openlive/client test
pnpm --filter @openlive/client typecheck
```
