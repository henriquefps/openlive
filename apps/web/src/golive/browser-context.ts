// SPDX-License-Identifier: AGPL-3.0-only
import type { AppRoomSession, AppVoiceSessions } from '../voice/use-voice-session.ts';
import type { BrowserContext } from './GoLive.tsx';

/**
 * What a browser stream needs of the room's session: its room socket, which the tab
 * announces on, and a hold that keeps the session open while live, as a page showing the room
 * does, so the stream survives leaving the room page within the app.
 */
export function browserContextOf(
  session: AppRoomSession,
  sessions: AppVoiceSessions,
): BrowserContext {
  const connection = session.parts.connection;
  return {
    socket: {
      listen: connection.listen,
      sendRequest: (type, payload) => connection.sendRequest(type, payload),
      onEnded: (listener) =>
        connection.subscribe(() => {
          if (connection.getState().ended) listener();
        }),
    },
    hold: () => sessions.view(session),
  };
}
