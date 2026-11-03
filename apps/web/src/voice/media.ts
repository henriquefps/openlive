// SPDX-License-Identifier: AGPL-3.0-only
import { sessionVoiceMedia as coreSessionVoiceMedia } from '@openlive/client';
import type { RtcSession } from '../rtc/session.ts';
import type { VoiceApi } from './api.ts';
import type { VoiceMedia } from './client.ts';

// Voice on the room's SFU session is @openlive/client's sessionVoiceMedia (voice/media.ts
// there) on the browser's tracks.

export const sessionVoiceMedia = (session: RtcSession, api: VoiceApi): VoiceMedia =>
  coreSessionVoiceMedia(session, api);
