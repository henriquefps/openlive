// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubContext } from '../src/hub/use-hub.ts';
import { HubNotices, NoticeProvider } from '../src/notices/AppNotices.tsx';
import { NotificationSettingsCard } from '../src/notices/NotificationSettingsCard.tsx';
import {
  loadNoticeSettings,
  noticeSettings,
  DEFAULT_NOTICE_SETTINGS,
} from '../src/notices/settings.ts';
import { stepsFor } from '../src/tutorial/steps.ts';
import type { VoiceClient } from '../src/voice/client.ts';
import { DEFAULT_DUCKING, loadDucking, streamDucking } from '../src/voice/ducking.ts';
import { VoiceBar } from '../src/voice/VoiceBar.tsx';
import { VoicePresence } from '../src/voice/VoicePeople.tsx';
import { VoiceSettingsCard } from '../src/voice/VoiceSettingsCard.tsx';
import en from '../src/locales/en/translation.json';
import ptBR from '../src/locales/pt-BR/translation.json';
import { connectedHub } from './hub-fakes.ts';
import { participant, setupVoice } from './voice-fakes.ts';

// The notices and the voice polish on screen: Settings → Notifications and the ducking switch,
// the one-time tips, the boost warning, a hub notice turned into a toast, and the tutorial's new
// steps.

const toasts = vi.hoisted(() => ({ plain: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(toasts.plain, { warning: toasts.warning }),
}));

afterEach(() => {
  // The tab-wide stores keep their values between tests; put the defaults back.
  noticeSettings.update(DEFAULT_NOTICE_SETTINGS);
  streamDucking.setPrefs(DEFAULT_DUCKING);
  toasts.plain.mockClear();
  toasts.warning.mockClear();
  vi.restoreAllMocks();
});

describe('Settings → Notifications', () => {
  it('lists each notice with its default, and remembers a change', async () => {
    const user = userEvent.setup();
    render(<NotificationSettingsCard />);
    const card = screen.getByTestId('notification-settings');
    const toggle = (name: string) => within(card).getByRole('switch', { name });
    expect(toggle('Someone starts streaming')).toBeChecked();
    expect(toggle('A slot opens in the queue')).toBeChecked();
    expect(toggle('Someone starts watching your stream')).not.toBeChecked();
    expect(toggle('Your stream drops or your network is unstable')).toBeChecked();
    expect(toggle('Someone mentions you in a chat')).toBeChecked();
    expect(toggle('You join or leave voice')).toBeChecked();
    expect(toggle('Someone joins or leaves your voice')).toBeChecked();

    await user.click(toggle('Someone starts watching your stream'));
    expect(toggle('Someone starts watching your stream')).toBeChecked();
    expect(loadNoticeSettings().events.viewerJoined).toBe(true);
  });

  it('"mute all" keeps the toggles and turns the volume and the previews off', async () => {
    const user = userEvent.setup();
    render(<NotificationSettingsCard />);
    const card = screen.getByTestId('notification-settings');
    expect(within(card).getByRole('slider', { name: /Volume/ })).not.toHaveAttribute(
      'data-disabled',
    );
    await user.click(within(card).getByRole('switch', { name: 'Mute all sounds' }));
    expect(loadNoticeSettings().muted).toBe(true);
    expect(within(card).getByRole('slider', { name: /Volume/ })).toHaveAttribute('data-disabled');
    expect(
      within(card).getByRole('button', { name: 'Play the sound for: Someone starts streaming' }),
    ).toBeDisabled();
    expect(within(card).getByRole('switch', { name: 'Someone starts streaming' })).toBeChecked();
  });
});

describe('Settings → Voice: ducking', () => {
  it('on by default at −12 dB; off is remembered and disables the amount', async () => {
    const user = userEvent.setup();
    render(<VoiceSettingsCard />);
    const card = screen.getByTestId('voice-settings');
    const duck = within(card).getByRole('switch', {
      name: 'Lower the stream while someone speaks',
    });
    expect(duck).toBeChecked();
    expect(within(card).getByRole('combobox', { name: 'How much lower' })).toHaveTextContent(
      'Some (−12 dB)',
    );
    await user.click(duck);
    expect(loadDucking().enabled).toBe(false);
    expect(within(card).getByRole('combobox', { name: 'How much lower' })).toBeDisabled();
  });
});

function Bar({ client }: { client: VoiceClient }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  return <VoiceBar client={client} state={state} canJoin />;
}

async function joined() {
  const v = setupVoice();
  const user = userEvent.setup();
  const view = render(<Bar client={v.client} />);
  await user.click(screen.getByRole('button', { name: 'Join voice' }));
  await waitFor(() => expect(v.signal.sent[0]?.type).toBe('voice.join'));
  act(() => v.signal.admit([participant('u_bia')]));
  await screen.findByRole('toolbar', { name: 'Voice controls' });
  return { ...v, user, view };
}

describe('one-time tips in the voice bar', () => {
  it('"Your microphone is on" shows once on this device, and "Got it" hides it', async () => {
    const first = await joined();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Your microphone is on'),
    );
    await first.user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText(/Your microphone is on/)).not.toBeInTheDocument();
    // Muted still says so: only "sending" became a tip.
    await first.user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(screen.getByRole('status')).toHaveTextContent('You are muted.');
    first.view.unmount();

    await joined();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mute' })).toBeEnabled());
    expect(screen.queryByText(/Your microphone is on/)).not.toBeInTheDocument();
  });

  it('the iPhone note shows only on iOS, once', async () => {
    const other = await joined();
    expect(screen.queryByTestId('ios-tip')).not.toBeInTheDocument();
    other.view.unmount();

    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    );
    const ios = await joined();
    expect(screen.getByTestId('ios-tip')).toHaveTextContent(
      'On iPhone and iPad, keep this tab open with the screen on',
    );
    ios.view.unmount();
    await joined();
    expect(screen.queryByTestId('ios-tip')).not.toBeInTheDocument();
  });
});

describe('volume above 100 % without headphones', () => {
  const members = [
    { userId: 'u_bia', displayName: 'Bia', role: 'member' as const, canStream: true },
  ];

  function renderPresence(volume: number) {
    const v = setupVoice();
    const state = { ...v.client.getState(), volumes: { u_bia: volume } };
    render(
      <VoicePresence
        participants={[participant('u_bia')]}
        members={members}
        selfId="u_ana"
        client={v.client}
        state={state}
        moderator={null}
        moderation={{ serverMute: vi.fn(), kick: vi.fn(), cameraOff: vi.fn() }}
      />,
    );
  }

  it('warns on an unknown output, and only above 100 %', async () => {
    const user = userEvent.setup();
    renderPresence(1.5);
    await user.click(screen.getByRole('button', { name: 'Voice options for Bia' }));
    expect(await screen.findByTestId('boost-warning')).toHaveTextContent(
      'echo cancellation may not cover this voice',
    );
    expect(screen.getByRole('slider')).toHaveAccessibleDescription(
      /echo cancellation may not cover this voice/,
    );
  });

  it('no warning at 100 %', async () => {
    const user = userEvent.setup();
    renderPresence(1);
    await user.click(screen.getByRole('button', { name: 'Voice options for Bia' }));
    await screen.findByText('Volume of Bia');
    expect(screen.queryByTestId('boost-warning')).not.toBeInTheDocument();
  });

  it('no warning on headphones', async () => {
    const enumerateDevices = vi.fn(() =>
      Promise.resolve([
        { deviceId: 'default', kind: 'audiooutput', label: 'Default - AirPods Pro' },
      ] as MediaDeviceInfo[]),
    );
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), { mediaDevices: { enumerateDevices } }),
    );
    try {
      const user = userEvent.setup();
      renderPresence(1.5);
      await user.click(screen.getByRole('button', { name: 'Voice options for Bia' }));
      await screen.findByText('Volume of Bia');
      await waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
      expect(screen.queryByTestId('boost-warning')).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('hub notices', () => {
  it('your stream dropping is a warning toast', () => {
    const { hub, socket } = connectedHub();
    render(
      <HubContext value={hub}>
        <NoticeProvider>
          <HubNotices />
        </NoticeProvider>
      </HubContext>,
    );
    const live = {
      deviceId: 'd_pc',
      state: 'live',
      stream: { roomId: 'r_1', streamId: 'st_1', sourceId: 's', preset: 'game' },
    };
    act(() => socket.receive('helper.status', live));
    expect(toasts.warning).not.toHaveBeenCalled();
    act(() => socket.receive('helper.status', { ...live, state: 'error' }));
    expect(toasts.warning).toHaveBeenCalledWith('Your stream dropped', {
      description: 'The helper lost its connection or stopped with an error.',
    });
  });

  it('turned off in the settings: no toast either', () => {
    noticeSettings.update({ events: { streamProblem: false } });
    const { hub, socket } = connectedHub();
    render(
      <HubContext value={hub}>
        <NoticeProvider>
          <HubNotices />
        </NoticeProvider>
      </HubContext>,
    );
    const live = {
      deviceId: 'd_pc',
      state: 'live',
      stream: { roomId: 'r_1', streamId: 'st_1', sourceId: 's', preset: 'game' },
    };
    act(() => socket.receive('helper.status', live));
    act(() => socket.receive('helper.status', { ...live, state: 'error' }));
    expect(toasts.warning).not.toHaveBeenCalled();
  });
});

describe('tutorial', () => {
  it('has the Voice connected panel, the camera toggle and the chat button, in both languages', () => {
    expect(stepsFor('voice').map((s) => s.anchor)).toEqual([
      'voice-connected',
      'voice-mute',
      'voice-deafen',
      'voice-camera',
      'voice-devices',
    ]);
    expect(stepsFor('room').map((s) => s.id)).toContain('chatButton');
    for (const locale of [en, ptBR]) {
      const tutorial = locale.tutorial as unknown as Record<
        string,
        Record<string, { title: string }>
      >;
      expect(tutorial['voice']?.['panel']?.title).toBeTruthy();
      expect(tutorial['voice']?.['camera']?.title).toBeTruthy();
      expect(tutorial['room']?.['chatButton']?.title).toBeTruthy();
    }
  });
});
