// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import type { Member } from '@openlive/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/i18n/index.ts';
import { RoomStage } from '../src/routes/room/RoomStage.tsx';
import type { VoiceClientState } from '../src/voice/client.ts';
import type { VoiceParticipant } from '../src/voice/contract.ts';
import { CAMERA_OFF } from '../src/voice/use-voice-session.ts';
import type { VoicePeopleProps } from '../src/voice/VoicePeople.tsx';
import { FakeCameraTrack } from './camera-fakes.ts';
import { FakeMediaStream } from './rtc-fakes.ts';
import { participant } from './voice-fakes.ts';

// The stage as a call (RoomStage.tsx + stage-layout.ts) on a measured 1000×600 stage: the 1:1
// picture-in-picture, the voice-only strip beside cameras, and the speaking ring drawn inside the
// tile (nothing to clip it).

const members: Member[] = [
  { userId: 'u_me', displayName: 'Ana', role: 'member', canStream: true },
  { userId: 'u_bia', displayName: 'Bia', role: 'member', canStream: true },
  { userId: 'u_caio', displayName: 'Caio', role: 'member', canStream: true },
];
const track = (id: string) => new FakeCameraTrack(id) as unknown as MediaStreamTrack;

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1000,
    height: 600,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Stage({
  participants,
  remote,
  speaking = {},
}: {
  participants: VoiceParticipant[];
  remote: Record<string, MediaStreamTrack>;
  speaking?: Record<string, boolean>;
}) {
  const people: VoicePeopleProps = {
    participants,
    members,
    selfId: 'u_me',
    client: null,
    state: { speaking, volumes: {} } as unknown as VoiceClientState,
    moderator: null,
    moderation: { serverMute: vi.fn(), kick: vi.fn(), cameraOff: vi.fn() },
  };
  return (
    <RoomStage
      streams={[]}
      people={people}
      cameras={{ client: null, state: { ...CAMERA_OFF, remote } }}
      focusId={null}
      focus={null}
      onWatch={vi.fn()}
      empty={{ title: 'Nobody', description: '' }}
    />
  );
}

describe('RoomStage as a call', () => {
  it('1:1: the other person fills the stage, you float as a picture-in-picture', () => {
    render(
      <Stage
        participants={[participant('u_me'), participant('u_bia', { camera: true })]}
        remote={{ u_bia: track('t_bia') }}
      />,
    );
    const pip = screen.getByTestId('stage-pip');
    expect(within(pip).getByText('You').closest('[data-voice-user]')).toHaveAttribute(
      'data-voice-user',
      'u_me',
    );
    const bia = screen
      .getByTestId('in-voice')
      .querySelector('[data-voice-user="u_bia"]') as HTMLElement;
    expect(bia).toHaveAttribute('data-variant', 'tile');
    expect(bia.style.width).toBe('1000px');
    expect(screen.queryByTestId('stage-strip')).not.toBeInTheDocument();
  });

  it('beside a camera, the voice-only people sit in the strip', () => {
    render(
      <Stage
        participants={[
          participant('u_me'),
          participant('u_bia', { camera: true }),
          participant('u_caio'),
        ]}
        remote={{ u_bia: track('t_bia') }}
      />,
    );
    expect(screen.queryByTestId('stage-pip')).not.toBeInTheDocument();
    const strip = screen.getByTestId('stage-strip');
    expect(
      [...strip.querySelectorAll('[data-voice-user]')].map((e) =>
        e.getAttribute('data-voice-user'),
      ),
    ).toEqual(['u_me', 'u_caio']);
    // Everyone is still in the one "In voice" list.
    expect(screen.getByRole('list', { name: 'In voice (3)' })).toBe(screen.getByTestId('in-voice'));
  });

  it('draws the speaking ring inside the tile, over the video', () => {
    render(
      <Stage
        participants={[participant('u_me'), participant('u_bia'), participant('u_caio')]}
        remote={{}}
        speaking={{ u_bia: true }}
      />,
    );
    const bia = document.querySelector('[data-voice-user="u_bia"]') as HTMLElement;
    expect(bia).toHaveAttribute('data-speaking', 'true');
    expect(bia.querySelector('.ring-inset.ring-primary')).not.toBeNull();
    const caio = document.querySelector('[data-voice-user="u_caio"]') as HTMLElement;
    expect(caio.querySelector('.ring-inset')).toBeNull();
  });
});
