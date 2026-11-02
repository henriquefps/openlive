// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Member } from '@openlive/protocol';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n/index.ts';
import type { CameraClient } from '../src/voice/camera.ts';
import type { VoiceClient } from '../src/voice/client.ts';
import { CameraStrip } from '../src/voice/CameraStrip.tsx';
import { VoiceBar } from '../src/voice/VoiceBar.tsx';
import { camera, setupCamera } from './camera-fakes.ts';
import { FakeMediaStream } from './rtc-fakes.ts';
import { participant, setupVoice } from './voice-fakes.ts';

// The camera in the voice bar and the camera strip: the toggle
// only in a room with cameras, "you're on camera", the room's reasons, the strip on the low layer
// and enlarging on click.

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage('en');
});

function Bar({
  voice,
  camera: cam,
  allowed = true,
}: {
  voice: VoiceClient;
  camera: CameraClient | null;
  allowed?: boolean;
}) {
  const state = useSyncExternalStore(voice.subscribe, voice.getState);
  const cameraState = useSyncExternalStore(
    (l) => cam?.subscribe(l) ?? (() => undefined),
    () => cam?.getState() ?? null,
  );
  return (
    <VoiceBar
      client={voice}
      state={state}
      canJoin
      camera={cam && cameraState ? { client: cam, state: cameraState, allowed } : null}
    />
  );
}

async function joined(options: { cameras?: boolean; allowed?: boolean } = {}) {
  const v = setupVoice();
  const c = setupCamera(v.signal);
  const user = userEvent.setup();
  render(
    <Bar
      voice={v.client}
      camera={options.cameras === false ? null : c.client}
      allowed={options.allowed ?? true}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Join voice' }));
  await waitFor(() => expect(v.signal.sent[0]?.type).toBe('voice.join'));
  act(() => v.signal.admit([participant('u_bia')]));
  await screen.findByRole('toolbar', { name: 'Voice controls' });
  return { v, c, user };
}

describe('camera in the voice bar', () => {
  it('has no camera toggle in a room without cameras', async () => {
    await joined({ cameras: false });
    expect(screen.queryByTestId('camera-toggle')).not.toBeInTheDocument();
  });

  it('turns the camera on and says so, then off', async () => {
    const { c, user } = await joined();
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }));
    await screen.findByText("You're on camera");
    expect(c.client.getState().phase).toBe('on');
    await user.click(screen.getByRole('button', { name: 'Turn camera off' }));
    expect(screen.queryByText("You're on camera")).not.toBeInTheDocument();
  });

  it('is disabled for someone the room does not let use a camera', async () => {
    await joined({ allowed: false });
    expect(screen.getByTestId('camera-toggle')).toBeDisabled();
    expect(screen.getByTestId('camera-toggle')).toHaveAccessibleName(
      'Cameras are off for you in this room.',
    );
  });

  it('says why the room refused or turned the camera off', async () => {
    const { c, v, user } = await joined();
    c.media.refuse('camera_limit_reached', { limit: 6 });
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }));
    expect(await screen.findByTestId('camera-notice')).toHaveTextContent(
      'This room already has 6 cameras on.',
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    act(() => v.signal.update({ cameraStopped: { reason: 'quota_exhausted', seq: 1 } }));
    expect(await screen.findByTestId('camera-notice')).toHaveTextContent('Voice keeps working.');
  });
});

describe('CameraStrip', () => {
  const members: Member[] = [
    { userId: 'u_me', displayName: 'Ana', role: 'member', canStream: true },
    { userId: 'u_bia', displayName: 'Bia', role: 'member', canStream: true },
    { userId: 'u_caio', displayName: 'Caio', role: 'member', canStream: true },
  ];

  function Strip({ cam }: { cam: CameraClient }) {
    const state = useSyncExternalStore(cam.subscribe, cam.getState);
    return (
      <CameraStrip
        participants={[
          participant('u_me'),
          participant('u_bia', { camera: true }),
          participant('u_caio'),
        ]}
        members={members}
        selfId="u_me"
        speaking={{ u_bia: true }}
        client={cam}
        state={state}
      />
    );
  }

  it('shows a tile per person in voice, the camera or the avatar, and enlarges on click', async () => {
    const c = setupCamera();
    act(() => {
      c.signal.admit([participant('u_bia', { camera: true }), participant('u_caio')]);
      c.signal.update({ cameras: [camera('u_bia')] });
    });
    render(<Strip cam={c.client} />);
    await waitFor(() => expect(c.media.media.pull).toHaveBeenCalled());
    const tiles = await screen.findAllByTestId('camera-tile');
    expect(tiles.map((t) => t.dataset['user'])).toEqual(['u_me', 'u_bia', 'u_caio']);
    // Bia's camera plays (muted: voices play through the voice client); Caio shows his avatar.
    const enlarge = await screen.findByRole('button', { name: "Enlarge Bia's camera" });
    expect(enlarge.querySelector('video')).toHaveProperty('muted', true);
    expect(tiles[2]?.querySelector('video')).toBeNull();
    fireEvent.click(enlarge);
    expect(c.media.media.setLayer).toHaveBeenLastCalledWith('ct_u_bia', 'h');
    expect(screen.getByTestId('camera-enlarged')).toHaveAttribute('data-user', 'u_bia');
    fireEvent.click(screen.getByRole('button', { name: 'Close the enlarged camera' }));
    expect(c.media.media.setLayer).toHaveBeenLastCalledWith('ct_u_bia', 'l');
    expect(screen.queryByTestId('camera-enlarged')).not.toBeInTheDocument();
  });

  it('is empty while nobody has a camera on', () => {
    const c = setupCamera();
    render(
      <CameraStrip
        participants={[participant('u_bia')]}
        members={members}
        selfId="u_me"
        speaking={{}}
        client={c.client}
        state={c.client.getState()}
      />,
    );
    expect(screen.queryByTestId('camera-strip')).not.toBeInTheDocument();
  });
});
