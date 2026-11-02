// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useHub } from '../hub/use-hub.ts';
import { useActiveVoice } from './use-voice-session.ts';
import { voiceSinkHelpers, voiceSinkOf } from './voice-sink.ts';

// Voice into the helper's voice sink (voice-sink.ts), in the shell while signed in:
// the voice client of the room this tab is in voice in learns the sink's label from the hub,
// and the helpers that have a sink learn which speakers to play it on (the output picked in
// Settings > Voice; the default when none is).

export function VoiceSinkRouting() {
  const { state, hub } = useHub();
  const active = useActiveVoice();
  const client = active?.session.parts.voice ?? null;
  const label = voiceSinkOf(state.helpers, state.statuses)?.label ?? null;
  useEffect(() => {
    client?.setVoiceSinkLabel(label);
  }, [client, label]);
  useEffect(() => () => client?.setVoiceSinkLabel(null), [client]);

  const routed = active?.voice.voiceSinkId != null;
  const output = active
    ? (active.voice.outputs.find((o) => o.deviceId === active.voice.outputId)?.label ?? '')
    : '';
  const targets = voiceSinkHelpers(state.helpers, state.statuses).join(',');
  useEffect(() => {
    if (!routed || !targets) return;
    for (const deviceId of targets.split(',')) {
      hub
        .request('helper.setVoiceOutput', { deviceId, ...(output ? { label: output } : {}) })
        .catch(() => undefined);
    }
  }, [hub, routed, output, targets]);
  return null;
}
