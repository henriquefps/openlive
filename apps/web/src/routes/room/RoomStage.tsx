// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowsInIcon, PlayIcon, UsersIcon } from '@phosphor-icons/react';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EmptyState } from '../../components/EmptyState.tsx';
import { BrowserPill, type StreamCardProps } from '../../components/StreamCard.tsx';
import { STATUS_DOT, type StatusTone } from '../../components/StatusBadge.tsx';
import type { CameraClient, CameraClientState } from '../../voice/camera.ts';
import { CameraVideo } from '../../voice/CameraStrip.tsx';
import type { VoiceParticipant } from '../../voice/contract.ts';
import {
  PersonMenu,
  StateIcons,
  VoiceAvatar,
  type VoicePeopleProps,
  useWho,
} from '../../voice/VoicePeople.tsx';
import {
  GAP,
  type LayoutTile,
  STRIP_TILE_WIDTH,
  type StageLayout,
  mainTileWidths,
  stageLayout,
  tileWidths,
} from './stage-layout.ts';
import { useElementSize, useHighLayers } from './use-stage-size.ts';

// The room's stage, laid out like a video call (stage-layout.ts): the live streams (LIVE, who
// streams, Watch) and everyone in voice (their camera, or their avatar with the speaking ring)
// fill the stage as large tiles, each camera cropped to fill its tile. Video comes first: beside
// cameras or streams, the voice-only people sit in a compact strip. In a 1:1 call your own tile
// floats in a corner. Enlarging someone's camera is the spotlight: that one big, the others in a
// filmstrip (beside it on a wide stage).
// Watching a stream is the focus mode: the player on top and every tile in a strip below; the
// player keeps its place in the tree at every width (CSS only), so it never remounts on a resize.

export type StageStream = StreamCardProps & { id: string };

export interface StageCameras {
  client: CameraClient | null;
  state: CameraClientState;
}

type Variant = 'tile' | 'compact' | 'side' | 'spotlight' | 'pip';
const TILE: Variant = 'tile';
const COMPACT: Variant = 'compact';
const SIDE: Variant = 'side';
const SPOTLIGHT: Variant = 'spotlight';
const PIP: Variant = 'pip';
const ENLARGED_TEST_ID = 'camera-enlarged';

type Item =
  | { kind: 'stream'; id: string; stream: StageStream }
  | { kind: 'person'; id: string; participant: VoiceParticipant; video: boolean; self: boolean };

export function RoomStage({
  streams,
  people,
  cameras,
  focusId,
  focus,
  onWatch,
  onHover,
  empty,
  emptyAction = null,
  large = false,
}: {
  /** The live streams (rooms with stream), oldest first. */
  streams: readonly StageStream[];
  /** Who is in voice (rooms with voice). */
  people: VoicePeopleProps | null;
  /** Their cameras (rooms with cameras). */
  cameras: StageCameras | null;
  /** The stream being watched, shown as `focus`. */
  focusId: string | null;
  /** The watch view (the player) of `focusId`. */
  focus: ReactNode;
  onWatch: (streamId: string) => void;
  /** Pull on hover (rtc/prepull.ts): desktop pointers only. */
  onHover?: ((streamId: string, hovering: boolean) => void) | undefined;
  /** What an empty stage says. */
  empty: { title: string; description: string };
  /** A button in the empty stage (Join voice). */
  emptyAction?: ReactNode;
  /** A voice channel, where the people are the page: larger voice-only tiles. */
  large?: boolean;
}) {
  const { t } = useTranslation();
  const watching = focus !== null;
  const enlarged = watching ? null : (cameras?.state.enlarged ?? null);
  const who = useWho(people?.members ?? []);
  const participants = people?.participants ?? [];
  const trackOf = (userId: string) =>
    cameras
      ? userId === people?.selfId
        ? cameras.state.preview
        : (cameras.state.remote[userId] ?? null)
      : null;

  const items: Item[] = [
    ...streams
      .filter((s) => s.id !== focusId)
      .map((stream): Item => ({ kind: 'stream', id: `s:${stream.id}`, stream })),
    ...(people
      ? participants.map((p): Item => ({
          kind: 'person',
          id: `p:${p.userId}`,
          participant: p,
          video: trackOf(p.userId) !== null,
          self: p.userId === people.selfId,
        }))
      : []),
  ];
  const layoutTiles: LayoutTile[] = items.map((item) =>
    item.kind === 'stream'
      ? { id: item.id, video: true, stream: true }
      : { id: item.id, video: item.video, self: item.self },
  );
  const pinned =
    enlarged !== null && cameras?.state.remote[enlarged] !== undefined ? `p:${enlarged}` : null;
  const [areaRef, size] = useElementSize();
  // Cheap (a few tiles): computed on every render from the measured size.
  const layout = stageLayout({
    tiles: layoutTiles,
    width: size.width,
    height: size.height,
    pinned,
    large,
  });

  // The video quality follows the tile size: large camera tiles ask for the high layer.
  const remoteCameras = items.flatMap((item) =>
    item.kind === 'person' && item.video && !item.self ? [item.id] : [],
  );
  const byTile = watching
    ? new Map(remoteCameras.map((id) => [id, STRIP_TILE_WIDTH]))
    : size.width === 0
      ? null
      : tileWidths(layout, remoteCameras);
  const widths = byTile && new Map([...byTile].map(([id, width]) => [id.slice(2), width]));
  useHighLayers(cameras?.client, widths);

  const render = (item: Item, variant: Variant, style?: CSSProperties) => {
    if (item.kind === 'stream') {
      return (
        <StreamTile
          key={item.id}
          stream={item.stream}
          variant={variant}
          style={style}
          onWatch={() => onWatch(item.stream.id)}
          onHover={onHover}
        />
      );
    }
    const p = item.participant;
    const person = who(p.userId);
    return (
      <PersonTile
        key={item.id}
        participant={p}
        // `people` is set whenever there are person items.
        people={people as VoicePeopleProps}
        cameras={cameras}
        track={trackOf(p.userId)}
        name={item.self && cameras ? t('voice.camera.you') : person.name}
        avatarName={person.name}
        avatarUrl={person.avatarUrl}
        role={person.role}
        variant={variant}
        style={style}
      />
    );
  };

  const listProps = {
    role: 'list',
    'data-testid': people ? 'in-voice' : undefined,
    'aria-label': people ? t('voice.inVoice', { count: participants.length }) : t('room.streams'),
  } as const;

  let body: ReactNode;
  if (items.length === 0) {
    body = !watching && (
      <EmptyState icon={UsersIcon} title={empty.title} description={empty.description}>
        {emptyAction}
      </EmptyState>
    );
  } else if (watching) {
    // Watching a stream: every tile in a strip under the player.
    body = (
      <div {...listProps} className="flex gap-2 overflow-x-auto pb-1">
        {items.map((item) => render(item, COMPACT))}
      </div>
    );
  } else {
    body = (
      <div ref={areaRef} className="relative min-h-0 flex-1" data-testid="stage-area">
        <Gallery
          layout={layout}
          items={items}
          render={render}
          measured={size.width > 0}
          {...listProps}
        />
      </div>
    );
  }

  const mode = watching ? 'focus' : layout.mode === 'spotlight' ? 'focus' : 'grid';
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-3',
        !watching && items.length > 0 && 'min-h-48 flex-1',
      )}
      aria-label={t('room.stage.label')}
      data-testid="room-stage"
      data-tour="room-streams"
      data-mode={mode}
      data-layout={watching ? 'watch' : layout.mode}
    >
      {focus}
      {body}
    </section>
  );
}

/** The stage's tiles placed as stage-layout.ts says: main grid, strip, filmstrip, PiP. */
function Gallery({
  layout,
  items,
  render,
  measured,
  ...listProps
}: {
  layout: StageLayout;
  items: readonly Item[];
  render: (item: Item, variant: Variant, style?: CSSProperties) => ReactNode;
  measured: boolean;
  role: 'list';
  'data-testid': string | undefined;
  'aria-label': string;
}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const pick = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
  const main = pick(layout.main);
  const strip = pick(layout.strip);
  const pip = layout.pip ? byId.get(layout.pip) : undefined;
  const side = layout.stripSide === 'side';
  const spotlight = layout.mode === 'spotlight';
  // Before the first measure (and in tests) the tiles take a plain responsive size. Measured,
  // each row is its own centred line, so a last row that is not full can have wider tiles.
  const widths = mainTileWidths(layout);
  const styleOf = (index: number): CSSProperties | undefined =>
    measured
      ? {
          width: Math.floor(widths[index] ?? layout.tileWidth),
          height: Math.floor(layout.tileHeight),
        }
      : undefined;
  const rows: Item[][] = [];
  const perRow = measured ? Math.max(1, layout.columns) : main.length;
  for (let index = 0; index < main.length; index += perRow) {
    rows.push(main.slice(index, index + perRow));
  }

  return (
    <div
      {...listProps}
      className={cn('absolute inset-0 flex gap-2', side ? 'flex-row' : 'flex-col')}
      data-columns={layout.columns}
      data-rows={layout.rows}
    >
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <div className={cn('relative flex flex-col gap-2', !measured && 'w-full')}>
          {rows.map((row, r) => (
            <div
              key={r}
              className={cn('flex justify-center gap-2', !measured && 'flex-wrap')}
              // Rows group the list items visually only.
              role="presentation"
            >
              {row.map((item, i) =>
                render(item, spotlight ? SPOTLIGHT : TILE, styleOf(r * perRow + i)),
              )}
            </div>
          ))}
          {pip && (
            <PipFrame width={layout.pipWidth} height={layout.pipHeight}>
              {render(pip, PIP)}
            </PipFrame>
          )}
        </div>
      </div>
      {strip.length > 0 && (
        <div
          className={cn(
            'flex shrink-0 gap-2',
            side
              ? 'flex-col overflow-y-auto'
              : 'items-start overflow-x-auto pb-1 *:first:ml-auto *:last:mr-auto',
          )}
          style={side ? { width: layout.stripSize - GAP } : { height: layout.stripSize - GAP }}
          data-testid="stage-strip"
        >
          {strip.map((item) => render(item, side ? SIDE : COMPACT))}
        </div>
      )}
    </div>
  );
}

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
const CORNER_CLASS: Record<Corner, string> = {
  'top-left': 'top-2 left-2',
  'top-right': 'top-2 right-2',
  'bottom-left': 'bottom-2 left-2',
  'bottom-right': 'bottom-2 right-2',
};

/** Your own tile floating over the other person's (1:1); drag it to another corner. */
function PipFrame({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [corner, setCorner] = useState<Corner>('bottom-right');
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || s.id !== event.pointerId) return;
    setOffset({ x: event.clientX - s.x, y: event.clientY - s.y });
  };
  const onPointerUp = () => {
    const s = start.current;
    start.current = null;
    setOffset(null);
    const parent = frame.current?.parentElement;
    if (!s || !parent || !frame.current) return;
    // Snap to the corner nearest to where it was dropped.
    const box = parent.getBoundingClientRect();
    const rect = frame.current.getBoundingClientRect();
    const x = rect.left + rect.width / 2 < box.left + box.width / 2 ? 'left' : 'right';
    const y = rect.top + rect.height / 2 < box.top + box.height / 2 ? 'top' : 'bottom';
    setCorner(`${y}-${x}`);
  };
  return (
    <div
      ref={frame}
      className={cn(
        'absolute z-10 cursor-grab touch-none rounded-xl shadow-md active:cursor-grabbing',
        CORNER_CLASS[corner],
      )}
      style={{
        width,
        height,
        ...(offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : {}),
      }}
      title={t('room.stage.pip')}
      data-testid="stage-pip"
      data-corner={corner}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {children}
    </div>
  );
}

const STATUS_TONE: Record<StageStream['status'], StatusTone> = {
  live: 'live',
  paused: 'warning',
  failed: 'failed',
};

/** A label on the always-black tile (player exception: dark overlay in any theme). */
function Pill({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-player/70 px-2 py-0.5 text-xs font-medium text-player-foreground">
      <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_DOT[tone])} />
      {label}
    </span>
  );
}

/** The outer size of a tile: set by the layout (tile, spotlight), fixed (strip) or its frame. */
const itemClass = (variant: Variant) =>
  cn(
    'relative shrink-0 list-none',
    variant === 'compact' && 'aspect-video w-40',
    variant === 'side' && 'aspect-video w-full',
    variant === 'pip' && 'size-full',
  );

/** Before the layout is measured, a main tile is a plain card. */
const unmeasured = (variant: Variant, style: CSSProperties | undefined) =>
  !style && (variant === 'tile' || variant === 'spotlight') && 'aspect-video w-full max-w-xl';

/**
 * The speaking ring and the pinned outline: drawn inside the tile on top of the video, so no
 * scroll container or neighbour clips them and nothing moves when they come and go.
 */
function TileRing({ speaking }: { speaking: boolean }) {
  if (!speaking) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[1] rounded-[inherit] ring-2 ring-primary ring-inset"
    />
  );
}

function StreamTile({
  stream,
  variant,
  style,
  onWatch,
  onHover,
}: {
  stream: StageStream;
  variant: Variant;
  style?: CSSProperties | undefined;
  onWatch: () => void;
  onHover?: ((streamId: string, hovering: boolean) => void) | undefined;
}) {
  const { t } = useTranslation();
  const full = stream.viewers.used >= stream.viewers.limit;
  const small = variant === 'compact' || variant === 'side';
  return (
    <div
      role="listitem"
      className={cn(itemClass(variant), unmeasured(variant, style))}
      style={style}
      data-stream={stream.id}
      {...(onHover
        ? {
            onPointerEnter: () => onHover(stream.id, true),
            onPointerLeave: () => onHover(stream.id, false),
          }
        : {})}
    >
      {/* `dark` scopes the dark tokens: the video area is black in both themes. */}
      <div className="dark relative size-full overflow-hidden rounded-xl border bg-player text-player-foreground transition-shadow hover:shadow-md">
        {stream.thumbnailUrl && (
          <img src={stream.thumbnailUrl} alt="" className="size-full object-contain" />
        )}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
          <Pill tone={STATUS_TONE[stream.status]} label={t(`stream.status.${stream.status}`)} />
          {full && <Pill tone="warning" label={t('stream.status.full')} />}
          {stream.economy && !small && <Pill tone="warning" label={t('stream.economy')} />}
          {stream.browser && !small && <BrowserPill />}
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-linear-to-t from-player/90 to-transparent p-2 pt-6">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[0.9375rem] font-medium">
              {small ? stream.name : t('room.live.streaming', { name: stream.name })}
            </span>
            {!small && (
              <span className="flex items-center gap-1 text-[0.8125rem] text-player-foreground/80 tabular-nums">
                {stream.source && <span className="truncate">{stream.source} ·</span>}
                <UsersIcon aria-hidden />
                <span aria-hidden>{t('stream.slots', stream.viewers)}</span>
                <span className="sr-only">{t('stream.slotsLabel', stream.viewers)}</span>
              </span>
            )}
          </div>
          {/* Stretched over the tile: a click anywhere watches. */}
          <Button
            size={small ? 'sm' : 'default'}
            onClick={onWatch}
            aria-label={t('stream.watch', { name: stream.name })}
            className="shrink-0 after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
          >
            <PlayIcon data-icon="inline-start" />
            {t('room.live.watch')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PersonTile({
  participant: p,
  people,
  cameras,
  track,
  name,
  avatarName,
  avatarUrl,
  role,
  variant,
  style,
}: {
  participant: VoiceParticipant;
  people: VoicePeopleProps;
  cameras: StageCameras | null;
  track: MediaStreamTrack | null;
  /** The label ("You" for yourself in a room with cameras). */
  name: string;
  /** Their display name, for the avatar's initial. */
  avatarName: string;
  avatarUrl: string | undefined;
  role: Parameters<typeof PersonMenu>[0]['role'];
  variant: Variant;
  style?: CSSProperties | undefined;
}) {
  const { t } = useTranslation();
  const self = p.userId === people.selfId;
  const speaking = people.state.speaking[p.userId] === true;
  const enlarged = cameras?.state.enlarged === p.userId;
  const small = variant === 'compact' || variant === 'side' || variant === 'pip';
  const width = typeof style?.width === 'number' ? style.width : 0;
  return (
    <div
      role="listitem"
      className={cn(itemClass(variant), unmeasured(variant, style))}
      style={style}
      data-voice-user={p.userId}
      data-voice-tile={p.userId}
      data-speaking={speaking ? 'true' : 'false'}
      data-testid={cameras ? 'camera-tile' : undefined}
      data-user={p.userId}
      data-variant={variant}
    >
      <div
        className="relative size-full overflow-hidden rounded-xl border bg-muted"
        {...(variant === 'spotlight'
          ? { 'data-testid': ENLARGED_TEST_ID, 'data-user': p.userId }
          : {})}
      >
        {track ? (
          <CameraVideo track={track} mirror={self && cameras?.state.facing === 'user'} />
        ) : (
          <span className="flex size-full items-center justify-center">
            <VoiceAvatar
              name={avatarName}
              avatarUrl={avatarUrl}
              speaking={speaking}
              large={!small && (width === 0 || width >= 200)}
            />
          </span>
        )}
        {track && !self && (
          // Stretched over the tile: a click enlarges the camera (the spotlight), or closes it.
          <button
            type="button"
            className="absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            aria-label={t('voice.camera.enlarge', { name })}
            aria-pressed={enlarged}
            onClick={() => cameras?.client?.enlarge(enlarged ? null : p.userId)}
          />
        )}
        <TileRing speaking={speaking} />
        <span
          className={cn(
            'absolute flex items-center gap-1 rounded-md bg-background/85',
            small
              ? 'bottom-1 left-1 max-w-[calc(100%-0.5rem)] px-1 text-xs'
              : 'bottom-2 left-2 max-w-[calc(100%-1rem)] px-1.5 py-0.5 text-[0.8125rem]',
          )}
        >
          <span className="truncate">
            {name}
            {self && !cameras && (
              <span className="text-muted-foreground"> {t('space.members.you')}</span>
            )}
          </span>
          <StateIcons participant={p} />
          {speaking && <span className="sr-only">{t('voice.state.speaking')}</span>}
        </span>
        <div className="absolute top-1 right-1 flex items-center gap-1">
          {variant === 'spotlight' && (
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={t('voice.camera.shrink')}
              onClick={() => cameras?.client?.enlarge(null)}
            >
              <ArrowsInIcon />
            </Button>
          )}
          <div className="rounded-md bg-background/70 empty:hidden">
            <PersonMenu {...people} participant={p} name={name} role={role} />
          </div>
        </div>
      </div>
    </div>
  );
}
