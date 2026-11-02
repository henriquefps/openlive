// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n/index.ts';
import type { VoiceClient } from '../src/voice/client.ts';
import { loadPrefs } from '../src/voice/prefs.ts';
import { JoinVoiceButton, VoiceBar } from '../src/voice/VoiceBar.tsx';
import { VoiceSettingsCard } from '../src/voice/VoiceSettingsCard.tsx';
import { participant, setupVoice } from './voice-fakes.ts';

// The voice bar against the voice client and its fakes (voice-fakes.ts): join, the controls once
// in, what the status line says, and the notices (listening only, headphones, removed).

afterEach(async () => {
  await i18n.changeLanguage('en');
});

function Bar({ client, canJoin = true }: { client: VoiceClient; canJoin?: boolean }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  return <VoiceBar client={client} state={state} canJoin={canJoin} />;
}

async function joinedBar(options: Parameters<typeof setupVoice>[0] = {}) {
  const v = setupVoice(options);
  const user = userEvent.setup();
  render(<Bar client={v.client} />);
  await user.click(screen.getByRole('button', { name: 'Join voice' }));
  await waitFor(() => expect(v.signal.sent[0]?.type).toBe('voice.join'));
  act(() => v.signal.admit([participant('u_bia')]));
  await screen.findByRole('toolbar', { name: 'Voice controls' });
  return { ...v, user };
}

describe('VoiceBar', () => {
  it('cannot join without the permission', () => {
    const v = setupVoice();
    render(<Bar client={v.client} canJoin={false} />);
    expect(screen.getByRole('button', { name: 'Join voice' })).toBeDisabled();
  });

  it('joins, then shows mute, deafen, devices and leave, and says the microphone is on', async () => {
    const { user, client } = await joinedBar();
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Deafen' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Audio devices and push-to-talk' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Your microphone is on'),
    );
    expect(
      screen.getByText('Tip: headphones sound better. Echo cancellation is on.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(client.getState().muted).toBe(true);
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('You are muted.');

    await user.click(screen.getByRole('button', { name: 'Deafen' }));
    expect(screen.getByRole('status')).toHaveTextContent('Deafened');
    await user.click(screen.getByRole('button', { name: 'Undeafen' }));
    // The mute from before deafen is back.
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByRole('button', { name: 'Join voice' })).toBeInTheDocument();
  });

  it('the headphones hint can be dismissed for good', async () => {
    const { user, saved } = await joinedBar();
    await user.click(screen.getByRole('button', { name: "Don't show again" }));
    expect(
      screen.queryByText('Tip: headphones sound better. Echo cancellation is on.'),
    ).not.toBeInTheDocument();
    expect(saved.at(-1)?.headphonesHintDismissed).toBe(true);
  });

  it('microphone denied: listening only, with the reason, and mute disabled', async () => {
    const v = setupVoice();
    v.devices.fail('NotAllowedError');
    const user = userEvent.setup();
    render(<Bar client={v.client} />);
    await user.click(screen.getByRole('button', { name: 'Join voice' }));
    await waitFor(() => expect(v.signal.sent[0]?.type).toBe('voice.join'));
    act(() => v.signal.admit());
    expect(
      await screen.findByText(
        'The browser blocked the microphone. Allow it in the site settings to speak.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('You are in voice, listening only.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mute' })).toBeDisabled();
  });

  it('push to talk: a hold button and the key in the status line', async () => {
    const { user, client } = await joinedBar({
      prefs: { pushToTalk: true, pushToTalkKey: 'KeyT' },
    });
    const hold = screen.getByRole('button', { name: 'Hold to talk (T)' });
    expect(screen.getByRole('status')).toHaveTextContent('hold T');
    await user.pointer({ keys: '[MouseLeft>]', target: hold });
    expect(client.getState().transmitting).toBe(true);
    await user.pointer({ keys: '[/MouseLeft]', target: hold });
    expect(client.getState().transmitting).toBe(false);
  });

  it('a refused join says why', async () => {
    const v = setupVoice();
    const user = userEvent.setup();
    render(<Bar client={v.client} />);
    await user.click(screen.getByRole('button', { name: 'Join voice' }));
    await waitFor(() => expect(v.signal.sent[0]?.type).toBe('voice.join'));
    act(() => v.signal.update({ self: 'out', error: { code: 'capability_disabled' } }));
    expect(await screen.findByText('This room does not have this feature.')).toBeInTheDocument();
  });

  it('removed by a moderator: says so', async () => {
    const v = await joinedBar();
    act(() => v.signal.update({ self: 'out', tracks: [], left: 'kicked' }));
    expect(await screen.findByText('A moderator removed you from voice.')).toBeInTheDocument();
  });

  it('speaks Portuguese', async () => {
    await i18n.changeLanguage('pt-BR');
    const v = setupVoice();
    render(<Bar client={v.client} />);
    expect(screen.getByRole('button', { name: 'Entrar na voz' })).toBeInTheDocument();
  });
});

describe('Settings → Voice', () => {
  it('turns push-to-talk on and changes its key, remembered for the voice bar', async () => {
    const user = userEvent.setup();
    render(<VoiceSettingsCard />);
    await user.click(screen.getByRole('switch', { name: 'Push to talk' }));
    expect(loadPrefs().pushToTalk).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('status')).toHaveTextContent('Press a key');
    await user.keyboard('b');
    expect(loadPrefs().pushToTalkKey).toBe('KeyB');
    expect(screen.getByText('B')).toBeInTheDocument();
  });
});

/** The room's Join voice and the docked bar: the status and notices, no controls of its own. */
function DockedBar({ client }: { client: VoiceClient }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  return (
    <>
      {state.phase !== 'joined' && <JoinVoiceButton client={client} state={state} canJoin />}
      <div data-testid="notices">
        <VoiceBar client={client} state={state} canJoin docked />
      </div>
    </>
  );
}

describe('JoinVoiceButton and the docked voice bar', () => {
  it('Join, then the status line with the devices but no mute, deafen or leave there', async () => {
    const v = setupVoice();
    const user = userEvent.setup();
    render(<DockedBar client={v.client} />);
    // Docked, the voice bar has no Join of its own.
    expect(screen.getAllByRole('button', { name: 'Join voice' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Join voice' }));
    await waitFor(() => expect(v.signal.sent[0]?.type).toBe('voice.join'));
    act(() => v.signal.admit([participant('u_bia')]));
    const notices = screen.getByTestId('notices');
    await waitFor(() =>
      expect(within(notices).getByRole('status')).toHaveTextContent('Your microphone is on'),
    );
    // The controls are the "Voice connected" panel's (VoiceConnected.tsx), not here.
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mute' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join voice' })).not.toBeInTheDocument();
    expect(
      within(notices).getByRole('button', { name: 'Audio devices and push-to-talk' }),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText('Tip: headphones sound better. Echo cancellation is on.'),
    ).toBeInTheDocument();
  });

  it('shows Hold to talk on the status line while push-to-talk is on', async () => {
    const v = setupVoice();
    const user = userEvent.setup();
    render(<DockedBar client={v.client} />);
    await user.click(screen.getByRole('button', { name: 'Join voice' }));
    await waitFor(() => expect(v.signal.sent[0]?.type).toBe('voice.join'));
    act(() => v.signal.admit([]));
    act(() => v.client.setPushToTalk(true));
    expect(await screen.findByRole('button', { name: /Hold to talk/ })).toBeInTheDocument();
  });
});
