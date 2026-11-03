// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperInfo } from '@openlive/protocol';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubContext } from '../src/hub/use-hub.ts';
import i18n from '../src/i18n/index.ts';
import {
  actsOnShortcuts,
  CLAIM_STALE_MS,
  type ClaimStorage,
  claimShortcutTab,
  helperHasVoiceShortcuts,
  releaseShortcutTab,
  applyVoiceShortcut,
} from '../src/voice/global-shortcuts.ts';
import { VoiceBar } from '../src/voice/VoiceBar.tsx';
import { VoiceSettingsCard } from '../src/voice/VoiceSettingsCard.tsx';
import { connectedHub, PC } from './hub-fakes.ts';
import { participant, setupVoice } from './voice-fakes.ts';

// Global voice shortcuts through the helper (PROTOCOL 8.5): the hub connection hands every
// helper.voiceShortcut to listeners in order, the tab in voice applies it like the in-page
// controls, only one tab acts, and Settings / the voice bar say a helper provides them.

const NEW_PC: HelperInfo = { ...PC, deviceId: 'd_new', protocol: { major: 1, minor: 21 } };

function memoryStore(): ClaimStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

async function joined(options: Parameters<typeof setupVoice>[0] = {}) {
  const v = setupVoice(options);
  void v.client.join();
  await waitFor(() => expect(v.signal.sent[0]?.type).toBe('voice.join'));
  act(() => v.signal.admit([participant('u_bia')]));
  await waitFor(() => expect(v.client.getState().phase).toBe('joined'));
  return v;
}

describe('which helpers have voice shortcuts', () => {
  it('1.21 and later', () => {
    expect(helperHasVoiceShortcuts(PC)).toBe(false);
    expect(helperHasVoiceShortcuts(NEW_PC)).toBe(true);
    expect(helperHasVoiceShortcuts({ protocol: { major: 2, minor: 0 } })).toBe(true);
  });
});

describe('HubConnection.onVoiceShortcut', () => {
  it('delivers each press and release in order, and stops after unsubscribing', () => {
    const { hub, socket } = connectedHub([NEW_PC]);
    const seen: string[] = [];
    const off = hub.onVoiceShortcut((s) => seen.push(`${s.action}:${s.pressed}`));
    socket.receive('helper.voiceShortcut', {
      deviceId: 'd_new',
      action: 'pushToTalk',
      pressed: true,
    });
    socket.receive('helper.voiceShortcut', {
      deviceId: 'd_new',
      action: 'pushToTalk',
      pressed: false,
    });
    socket.receive('helper.voiceShortcut', {
      deviceId: 'd_new',
      action: 'toggleMute',
      pressed: true,
    });
    off();
    socket.receive('helper.voiceShortcut', {
      deviceId: 'd_new',
      action: 'toggleDeafen',
      pressed: true,
    });
    expect(seen).toEqual(['pushToTalk:true', 'pushToTalk:false', 'toggleMute:true']);
  });
});

describe('applyVoiceShortcut', () => {
  it('holds the microphone open while push-to-talk is down, only with push-to-talk on', async () => {
    const v = await joined({ prefs: { pushToTalk: true } });
    expect(v.client.getState().transmitting).toBe(false);
    applyVoiceShortcut(v.client, { action: 'pushToTalk', pressed: true });
    expect(v.client.getState().pttPressed).toBe(true);
    expect(v.client.getState().transmitting).toBe(true);
    applyVoiceShortcut(v.client, { action: 'pushToTalk', pressed: false });
    expect(v.client.getState().pttPressed).toBe(false);
    expect(v.client.getState().transmitting).toBe(false);

    v.client.setPushToTalk(false);
    applyVoiceShortcut(v.client, { action: 'pushToTalk', pressed: true });
    expect(v.client.getState().pttPressed).toBe(false);
  });

  it('toggles mute and deafen on the press, not on the release', async () => {
    const v = await joined();
    applyVoiceShortcut(v.client, { action: 'toggleMute', pressed: true });
    expect(v.client.getState().muted).toBe(true);
    applyVoiceShortcut(v.client, { action: 'toggleMute', pressed: false });
    expect(v.client.getState().muted).toBe(true);
    applyVoiceShortcut(v.client, { action: 'toggleMute', pressed: true });
    expect(v.client.getState().muted).toBe(false);

    applyVoiceShortcut(v.client, { action: 'toggleDeafen', pressed: true });
    expect(v.client.getState()).toMatchObject({ deafened: true, muted: true });
    applyVoiceShortcut(v.client, { action: 'toggleDeafen', pressed: true });
    expect(v.client.getState()).toMatchObject({ deafened: false, muted: false });
  });

  it('does nothing out of voice', () => {
    const idle = setupVoice();
    applyVoiceShortcut(idle.client, { action: 'toggleDeafen', pressed: true });
    applyVoiceShortcut(idle.client, { action: 'toggleMute', pressed: true });
    expect(idle.client.getState()).toMatchObject({ deafened: false, muted: false });
  });
});

describe('which tab acts', () => {
  it('the last tab to join voice acts; a closed tab does not hold it', () => {
    const store = memoryStore();
    expect(actsOnShortcuts('t_a', 0, store)).toBe(true); // nobody claimed: acts alone
    claimShortcutTab('t_a', 1_000, store);
    claimShortcutTab('t_b', 2_000, store);
    expect(actsOnShortcuts('t_b', 3_000, store)).toBe(true);
    expect(actsOnShortcuts('t_a', 3_000, store)).toBe(false);
    // t_b stopped renewing (closed): t_a acts again.
    expect(actsOnShortcuts('t_a', 2_000 + CLAIM_STALE_MS + 1, store)).toBe(true);
  });

  it('leaving voice gives the claim up only if it is this tab', () => {
    const store = memoryStore();
    claimShortcutTab('t_a', 1_000, store);
    claimShortcutTab('t_b', 2_000, store);
    releaseShortcutTab('t_a', store);
    expect(actsOnShortcuts('t_a', 2_500, store)).toBe(false);
    releaseShortcutTab('t_b', store);
    expect(actsOnShortcuts('t_a', 2_500, store)).toBe(true);
  });

  it('works without storage', () => {
    expect(actsOnShortcuts('t_a', 0, null)).toBe(true);
    expect(() => claimShortcutTab('t_a', 0, null)).not.toThrow();
  });
});

describe('the hint', () => {
  beforeEach(() => localStorage.clear());
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('Settings > Voice names the helper only when one supports the shortcuts', () => {
    const old = connectedHub([PC]);
    const { unmount } = render(
      <HubContext value={old.hub}>
        <VoiceSettingsCard />
      </HubContext>,
    );
    expect(screen.queryByTestId('global-shortcuts')).not.toBeInTheDocument();
    unmount();

    const fresh = connectedHub([PC, NEW_PC]);
    render(
      <HubContext value={fresh.hub}>
        <VoiceSettingsCard />
      </HubContext>,
    );
    const note = screen.getByTestId('global-shortcuts');
    expect(note).toHaveTextContent("Ana's PC");
    expect(note).toHaveTextContent('Ctrl+Alt+Shift+T');
    expect(note).toHaveTextContent('"shortcuts"');
  });

  it('the voice bar shows a subtle hint once in voice, and it can be dismissed', async () => {
    const { hub } = connectedHub([NEW_PC]);
    const v = await joined();
    function Bar() {
      const state = useSyncExternalStore(v.client.subscribe, v.client.getState);
      return <VoiceBar client={v.client} state={state} canJoin />;
    }
    const user = userEvent.setup();
    render(
      <HubContext value={hub}>
        <Bar />
      </HubContext>,
    );
    const tip = await screen.findByTestId('global-shortcuts-tip');
    expect(tip).toHaveTextContent('global shortcuts for push-to-talk, mute and deafen');
    await user.click(tip.querySelector('button') as HTMLElement);
    expect(screen.queryByTestId('global-shortcuts-tip')).not.toBeInTheDocument();
  });

  it('no hint with a helper before 1.21', async () => {
    const { hub } = connectedHub([PC]);
    const v = await joined();
    render(
      <HubContext value={hub}>
        <VoiceBar client={v.client} state={v.client.getState()} canJoin />
      </HubContext>,
    );
    expect(screen.queryByTestId('global-shortcuts-tip')).not.toBeInTheDocument();
  });
});
