// SPDX-License-Identifier: AGPL-3.0-only
import { createVoiceApi, type VoiceApi } from '@openlive/client';
import { webApi } from '../api/client.ts';

// The voice routes of the SFU proxy are @openlive/client's
// createVoiceApi on the web's cookie session.

export type { VoiceApi };

export const httpVoiceApi = (roomId: string): VoiceApi => createVoiceApi(webApi, roomId);
