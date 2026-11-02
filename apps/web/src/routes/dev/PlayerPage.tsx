// SPDX-License-Identifier: AGPL-3.0-only
import type { Member, StreamEndReason, StreamInfo } from '@openlive/protocol';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Page } from '../../components/Page.tsx';
import { StreamGrid } from '../../components/StreamGrid.tsx';
import type { FakeSource } from '../../player/dev/fake-source.ts';
import { type MediaFactory, MediaFactoryContext } from '../../player/media.ts';
import { INITIAL_STATE, type RoomState, type WatchAccess } from '../../room/connection.ts';
import type { WatchActions } from '../../room/socket-api.ts';
import { streamCards, WatchPanel } from '../room/RoomStreams.tsx';

// /dev/player (development builds only): the room's stream grid and watch view against a fake
// room and fake media, with a panel that forces every state. No backend needed. The panel's
// labels are developer tooling and stay in English (they are not in the locale files).

const SELF = 'u_me';
const ROOM_ID = 'rm_dev';
/** The fake sources playing now, by stream id, for the panel's network and helper controls. */
const SOURCES = new Map<string, FakeSource>();
const now = Date.now();

const MEMBERS: Member[] = [
  { userId: SELF, displayName: 'You', role: 'member', canStream: false },
  { userId: 'u_ana', displayName: 'Ana', role: 'owner', canStream: true },
  { userId: 'u_bruno', displayName: 'Bruno', role: 'member', canStream: true },
  {
    userId: 'u_carol',
    displayName: 'Carolina Albuquerque de Mendonça',
    role: 'admin',
    canStream: true,
  },
  { userId: 'u_diego', displayName: 'Diego', role: 'guest', canStream: true },
];

function stream(id: string, userId: string, patch: Partial<StreamInfo>): StreamInfo {
  return {
    streamId: id,
    userId,
    deviceId: `d_${userId}`,
    source: { kind: 'window', label: 'Hades II' },
    preset: 'game',
    hasAudio: true,
    paused: false,
    startedAt: now - 60_000,
    viewerLimit: 6,
    viewerCount: 2,
    ...patch,
  };
}

const STREAMS: StreamInfo[] = [
  stream('st_ana', 'u_ana', { startedAt: now - 300_000 }),
  stream('st_bruno', 'u_bruno', {
    source: { kind: 'window', label: 'Visual Studio Code' },
    preset: 'text',
    hasAudio: false,
    viewerCount: 6,
  }),
  stream('st_carol', 'u_carol', {
    source: { kind: 'screen', label: 'Entire screen 2 (DELL U2723QE)' },
    preset: 'max',
    paused: true,
    pauseReason: 'source_hidden',
  }),
];

const INITIAL: RoomState = {
  ...INITIAL_STATE,
  status: 'open',
  members: MEMBERS,
  streams: STREAMS,
};

type Setter = (update: (state: RoomState) => RoomState) => void;

function patchStream(id: string, patch: Partial<StreamInfo>): (s: RoomState) => RoomState {
  return (s) => ({
    ...s,
    streams: s.streams.map((x) => (x.streamId === id ? { ...x, ...patch } : x)),
  });
}

function setAccess(id: string, access: WatchAccess | null): (s: RoomState) => RoomState {
  return (s) => {
    const rest = Object.fromEntries(Object.entries(s.access).filter(([k]) => k !== id));
    return { ...s, access: access ? { ...rest, [id]: access } : rest };
  };
}

/** The room socket's slot and queue protocol, played locally (PROTOCOL 7.3). */
function useFakeActions(set: Setter, stateRef: RefObject<RoomState>): WatchActions {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  return useMemo(() => {
    const later = (ms: number, run: () => void) => timers.current.push(setTimeout(run, ms));
    const grant = (id: string) =>
      set((s) => {
        const info = s.streams.find((x) => x.streamId === id);
        const used = (s.viewers[id]?.used ?? info?.viewerCount ?? 0) + 1;
        return setAccess(id, {
          kind: 'granted',
          slotId: `sl_${id}_${Date.now()}`,
          expiresAt: Date.now() + 30_000,
          leaseMs: 30_000,
        })({
          ...s,
          viewers: {
            ...s.viewers,
            [id]: {
              streamId: id,
              viewerUserIds: [SELF, 'u_ana'],
              used,
              limit: info?.viewerLimit ?? 6,
              queueLength: 0,
            },
          },
        });
      });
    return {
      watch: (id) => {
        set(setAccess(id, { kind: 'requesting' }));
        later(300, () => {
          const info = stateRef.current.streams.find((x) => x.streamId === id);
          if (!info) return;
          const used = stateRef.current.viewers[id]?.used ?? info.viewerCount;
          if (used >= info.viewerLimit) set(setAccess(id, { kind: 'full', queue: null }));
          else grant(id);
        });
      },
      unwatch: (id) => {
        for (const timer of timers.current) clearTimeout(timer);
        timers.current = [];
        set(setAccess(id, null));
      },
      joinQueue: (id) => {
        set(setAccess(id, { kind: 'full', queue: 'joining' }));
        later(500, () => set(setAccess(id, { kind: 'full', queue: { position: 2, length: 3 } })));
        later(3_500, () => set(setAccess(id, { kind: 'full', queue: { position: 1, length: 2 } })));
        later(6_500, () =>
          set(setAccess(id, { kind: 'offer', offerId: 'of_1', expiresAt: Date.now() + 30_000 })),
        );
      },
      leaveQueue: (id) => {
        for (const timer of timers.current) clearTimeout(timer);
        timers.current = [];
        set(setAccess(id, { kind: 'full', queue: null }));
      },
      acceptOffer: (id) => {
        set(setAccess(id, { kind: 'requesting' }));
        later(300, () => grant(id));
      },
    };
  }, [set, stateRef]);
}

interface Control {
  label: string;
  run: () => void;
}

export function PlayerPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<RoomState>(INITIAL);
  const [watch, setWatch] = useState<string | null>('st_ana');
  const [theater, setTheater] = useState(false);
  const set: Setter = setState;
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const actions = useFakeActions(set, stateRef);

  const factory = useMemo<MediaFactory>(
    () =>
      async ({ stream: info }) => {
        const { FakeSource } = await import('../../player/dev/fake-source.ts');
        const source = new FakeSource(info.source.label, { audio: info.hasAudio });
        SOURCES.set(info.streamId, source);
        return {
          stream: source.stream,
          source,
          stop: () => {
            source.stop();
            if (SOURCES.get(info.streamId) === source) SOURCES.delete(info.streamId);
          },
        };
      },
    [],
  );

  const current = watch;
  const fake = () => (current ? SOURCES.get(current) : undefined);
  const end = (reason: StreamEndReason) => () => {
    if (!current) return;
    set((s) => ({
      ...s,
      streams: s.streams.filter((x) => x.streamId !== current),
      access: Object.fromEntries(Object.entries(s.access).filter(([k]) => k !== current)),
      endedStreams: { ...s.endedStreams, [current]: reason },
    }));
  };
  const restore = () => {
    setState(INITIAL);
    setWatch(null);
    setTimeout(() => setWatch(current), 0);
  };

  const groups: { title: string; controls: Control[] }[] = [
    {
      title: 'Stream',
      controls: [
        { label: 'Live', run: () => current && set(patchStream(current, { paused: false })) },
        {
          label: 'Paused (window hidden)',
          run: () =>
            current && set(patchStream(current, { paused: true, pauseReason: 'source_hidden' })),
        },
        {
          label: 'Privacy curtain',
          run: () =>
            current && set(patchStream(current, { paused: true, pauseReason: 'privacy_curtain' })),
        },
        { label: 'Ended by streamer', run: end('ended_by_streamer') },
        { label: 'Helper offline', run: end('helper_disconnected') },
      ],
    },
    {
      title: 'Network and helper',
      controls: [
        { label: 'Loss 8% (Automatic steps down)', run: () => fake()?.simulate({ loss: 0.08 }) },
        { label: 'No loss', run: () => fake()?.simulate({ loss: 0 }) },
        { label: 'Freeze (watchdog retries)', run: () => fake()?.simulate({ frozen: true }) },
        {
          label: 'Helper outdated (next connect)',
          run: () => {
            fake()?.simulate({ failWith: 'helper_outdated' });
            fake()?.retry();
          },
        },
        {
          label: 'No permission (next connect)',
          run: () => {
            fake()?.simulate({ failWith: 'no_permission' });
            fake()?.retry();
          },
        },
      ],
    },
    {
      title: 'Room and slot',
      controls: [
        {
          label: 'Room reconnecting',
          run: () => set((s) => ({ ...s, status: 'reconnecting', attempt: 1 })),
        },
        { label: 'Room connecting', run: () => set((s) => ({ ...s, status: 'connecting' })) },
        {
          label: 'Room expired',
          run: () =>
            set((s) => ({ ...s, status: 'ended', ended: { kind: 'closed', reason: 'expired' } })),
        },
        {
          label: 'Removed from room',
          run: () =>
            set((s) => ({ ...s, status: 'ended', ended: { kind: 'kicked', reason: 'removed' } })),
        },
        {
          label: 'Full (queue)',
          run: () => current && set(setAccess(current, { kind: 'full', queue: null })),
        },
        { label: 'Reset everything', run: restore },
      ],
    },
  ];

  return (
    <Page title={t('dev.player')} description={t('dev.playerIntro')}>
      <MediaFactoryContext value={factory}>
        <div
          className={cn('grid gap-6', !(watch && theater) && 'lg:grid-cols-[minmax(0,1fr)_18rem]')}
        >
          <div className="flex min-w-0 flex-col gap-6">
            {watch && (
              <WatchPanel
                key={watch}
                roomId={ROOM_ID}
                state={state}
                streamId={watch}
                actions={actions}
                theater={theater}
                onTheaterChange={setTheater}
                onClose={() => setWatch(null)}
              />
            )}
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow text-muted-foreground">{t('room.streams')}</h2>
              <StreamGrid
                streams={streamCards(state, t('player.someone'))}
                onOpen={setWatch}
                selectedId={watch}
              />
            </section>
          </div>
          <Card size="sm" className="self-start">
            <CardHeader>
              <CardTitle>{t('dev.player')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {groups.map((group) => (
                <div key={group.title} className="flex flex-col gap-2">
                  <h3 className="eyebrow text-muted-foreground">{group.title}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {group.controls.map((control) => (
                      <Button key={control.label} variant="outline" size="sm" onClick={control.run}>
                        {control.label}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </MediaFactoryContext>
    </Page>
  );
}
