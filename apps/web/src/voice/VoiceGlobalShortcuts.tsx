// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useHub } from '../hub/use-hub.ts';
import { TAB_ID } from '../room/connection.ts';
import {
  actsOnShortcuts,
  applyVoiceShortcut,
  CLAIM_RENEW_MS,
  claimShortcutTab,
  releaseShortcutTab,
} from './global-shortcuts.ts';
import { useActiveVoice } from './use-voice-session.ts';

// The helper's global voice shortcuts (global-shortcuts.ts, PROTOCOL.md 8.5) applied to the voice
// client of the room this tab is in voice in, from the shell while signed in. Only the tab in
// voice acts; with several, the last to join.

export function VoiceGlobalShortcuts() {
  const { state, hub } = useHub();
  const active = useActiveVoice();
  const client = active?.session.parts.voice ?? null;
  const joined = active?.voice.phase === 'joined';

  useEffect(() => {
    if (!joined) return;
    claimShortcutTab(TAB_ID);
    // Renewing never takes the claim from a tab that joined later.
    const timer = setInterval(() => {
      if (actsOnShortcuts(TAB_ID)) claimShortcutTab(TAB_ID);
    }, CLAIM_RENEW_MS);
    return () => {
      clearInterval(timer);
      releaseShortcutTab(TAB_ID);
    };
  }, [joined]);

  useEffect(() => {
    if (!client) return;
    return hub.onVoiceShortcut((shortcut) => {
      if (actsOnShortcuts(TAB_ID)) applyVoiceShortcut(client, shortcut);
    });
  }, [hub, client]);

  // A release lost with the hub socket must not leave the microphone open.
  const online = state.status === 'open';
  useEffect(() => {
    if (!online) client?.setPttPressed(false);
  }, [online, client]);
  return null;
}
