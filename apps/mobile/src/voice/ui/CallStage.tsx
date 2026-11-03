// SPDX-License-Identifier: AGPL-3.0-only
import {
  type CameraClient,
  type CameraClientState,
  GAP,
  type LayoutTile,
  mainTileWidths,
  pickHighLayers,
  stageLayout,
  STRIP_TILE_HEIGHT,
  STRIP_TILE_WIDTH,
  tileWidths,
  type VoiceParticipant,
} from '@openlive/client';
import type { Member } from '@openlive/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MediaStream, type MediaStreamTrack, RTCView } from 'react-native-webrtc';
import { Glyph, stateGlyph } from '../../components/Glyph.tsx';
import { Avatar } from '../../components/ui.tsx';
import { font, radius, useTheme } from '../../theme.ts';
import { stateIcons } from '../view.ts';

// The call's stage on a phone, laid out like a video call (packages/client voice/stage-layout.ts,
// the web's RoomStage): cameras fill the stage as a gallery (portrait tiles, the video cropped to
// fill), people without a camera sit in a compact strip below them, in a 1:1 call you float as a
// small picture-in-picture, and a tap on a camera pins it: that one big, the others in a strip.
// Long press (or the tile's menu button) opens the person's menu.

export const LAYER_DEBOUNCE_MS = 400;

type Variant = 'tile' | 'compact' | 'spotlight' | 'pip';
const TILE: Variant = 'tile';
const COMPACT: Variant = 'compact';
const SPOTLIGHT: Variant = 'spotlight';
const PIP: Variant = 'pip';
const BOX_NONE = 'box-none';
const COVER = 'cover';
const WHITE = '#fff';
const MENU_GLYPH = '⋯';

/** The slash over a state icon: red for a moderator's mute, white over a camera picture. */
function color(
  server: boolean,
  video: boolean,
  colors: { destructive: string; foreground: string },
) {
  return server ? colors.destructive : video ? WHITE : colors.foreground;
}

const streams = new WeakMap<MediaStreamTrack, MediaStream>();
/** react-native-webrtc's RTCView plays a MediaStream: one per track, made once. */
function streamOf(track: MediaStreamTrack): MediaStream {
  let stream = streams.get(track);
  if (!stream) {
    stream = new MediaStream([track]);
    streams.set(track, stream);
  }
  return stream;
}

export interface CallStageProps {
  participants: readonly VoiceParticipant[];
  members: readonly Member[];
  selfId: string;
  speaking: Readonly<Record<string, boolean>>;
  /** Cameras, when the room has them. */
  cameras: {
    client: CameraClient<MediaStreamTrack>;
    state: CameraClientState<MediaStreamTrack>;
  } | null;
  width: number;
  height: number;
  onMenu: (userId: string) => void;
}

export function CallStage(props: CallStageProps) {
  const { t } = useTranslation();
  const { participants, members, selfId, cameras, width, height } = props;
  const who = (userId: string) => {
    const member = members.find((m) => m.userId === userId);
    return { name: member?.displayName ?? t('mobile.voice.someone'), url: member?.avatarUrl };
  };
  const trackOf = (userId: string): MediaStreamTrack | null =>
    cameras
      ? userId === selfId
        ? cameras.state.preview
        : (cameras.state.remote[userId] ?? null)
      : null;
  const tiles: LayoutTile[] = participants.map((p) => ({
    id: p.userId,
    video: trackOf(p.userId) !== null,
    self: p.userId === selfId,
  }));
  const enlarged = cameras?.state.enlarged ?? null;
  const pinned =
    enlarged !== null && cameras?.state.remote[enlarged] !== undefined ? enlarged : null;
  const layout = stageLayout({ tiles, width, height, pinned, large: false });

  // Layer choice by tile size (the web's useHighLayers).
  const remote = tiles.filter((tile) => tile.video && !tile.self).map((tile) => tile.id);
  const widths = width === 0 ? null : tileWidths(layout, remote);
  useHighLayers(cameras?.client ?? null, widths);

  const byId = new Map(participants.map((p) => [p.userId, p]));
  const tile = (userId: string, box: { width: number; height: number }, variant: Variant) => {
    const p = byId.get(userId);
    if (!p) return null;
    const person = who(userId);
    return (
      <PersonTile
        key={userId}
        participant={p}
        name={userId === selfId ? t('mobile.voice.you') : person.name}
        avatarName={person.name}
        avatarUrl={person.url}
        track={trackOf(userId)}
        mirror={userId === selfId && cameras?.state.facing === 'user'}
        speaking={props.speaking[userId] === true}
        box={box}
        variant={variant}
        pinned={pinned === userId}
        onPin={() => {
          if (userId !== selfId && trackOf(userId))
            cameras?.client.enlarge(pinned === userId ? null : userId);
        }}
        onMenu={() => props.onMenu(userId)}
        self={userId === selfId}
      />
    );
  };

  const widthsMain = mainTileWidths(layout);
  const rows: string[][] = [];
  const perRow = Math.max(1, layout.columns);
  for (let i = 0; i < layout.main.length; i += perRow) rows.push(layout.main.slice(i, i + perRow));
  const spotlight = layout.mode === 'spotlight';
  const side = layout.stripSide === 'side';

  return (
    <View
      style={[styles.stage, { width, height }]}
      accessibilityLabel={t('voice.inVoice', { count: participants.length })}
    >
      <View style={[styles.fill, side && styles.rowDirection]}>
        <View style={styles.center}>
          <View style={styles.gallery}>
            {rows.map((row, r) => (
              <View key={r} style={styles.line}>
                {row.map((id, i) =>
                  tile(
                    id,
                    {
                      width: Math.floor(widthsMain[r * perRow + i] ?? layout.tileWidth),
                      height: Math.floor(layout.tileHeight),
                    },
                    spotlight ? SPOTLIGHT : TILE,
                  ),
                )}
              </View>
            ))}
            {layout.pip ? (
              <View style={styles.pip} pointerEvents={BOX_NONE}>
                {tile(layout.pip, { width: layout.pipWidth, height: layout.pipHeight }, PIP)}
              </View>
            ) : null}
          </View>
        </View>
        {layout.strip.length > 0 ? (
          <ScrollView
            horizontal={!side}
            style={
              side
                ? { width: layout.stripSize - GAP, flexGrow: 0 }
                : { height: layout.stripSize - GAP, flexGrow: 0 }
            }
            contentContainerStyle={styles.strip}
          >
            {layout.strip.map((id) =>
              tile(id, { width: STRIP_TILE_WIDTH, height: STRIP_TILE_HEIGHT }, COMPACT),
            )}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

function PersonTile({
  participant,
  name,
  avatarName,
  avatarUrl,
  track,
  mirror,
  speaking,
  box,
  variant,
  pinned,
  onPin,
  onMenu,
  self,
}: {
  participant: VoiceParticipant;
  name: string;
  avatarName: string;
  avatarUrl: string | null | undefined;
  track: MediaStreamTrack | null;
  mirror: boolean;
  speaking: boolean;
  box: { width: number; height: number };
  variant: Variant;
  pinned: boolean;
  onPin: () => void;
  onMenu: () => void;
  self: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const small = variant === COMPACT || variant === PIP;
  const icons = stateIcons(participant);
  const avatar = small ? 36 : Math.max(48, Math.min(96, Math.min(box.width, box.height) * 0.4));
  const stream = useMemo(() => (track ? streamOf(track) : null), [track]);
  const label = [
    name,
    ...icons.map((icon) => t(icon === 'camera' ? 'voice.state.camera' : `voice.state.${icon}`)),
    speaking ? t('voice.state.speaking') : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={
        track && !self ? t(pinned ? 'mobile.voice.unpin' : 'mobile.voice.pin', { name }) : undefined
      }
      onPress={onPin}
      onLongPress={self ? undefined : onMenu}
      style={[
        styles.tile,
        {
          width: box.width,
          height: box.height,
          backgroundColor: colors.card,
          borderColor: speaking ? colors.primary : colors.border,
          borderWidth: speaking ? 2 : 1,
        },
      ]}
    >
      {stream ? (
        <RTCView
          streamURL={stream.toURL()}
          objectFit={COVER}
          mirror={mirror}
          zOrder={variant === PIP ? 1 : 0}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={styles.avatarBox}>
          <Avatar name={avatarName} url={avatarUrl} size={avatar} ring={speaking} />
        </View>
      )}
      <View style={styles.label}>
        <Text
          numberOfLines={1}
          style={[
            styles.flexName,
            styles.name,
            { color: stream ? '#fff' : colors.foreground },
            small && styles.nameSmall,
          ]}
        >
          {name}
        </Text>
        {variant !== PIP
          ? icons
              .filter((icon) => icon !== 'camera')
              .map((icon) => (
                <Glyph
                  key={icon}
                  name={stateGlyph(icon)}
                  size={13}
                  slashed
                  color={color(icon === 'serverMuted', stream !== null, colors)}
                />
              ))
          : null}
      </View>
      {!self && variant !== PIP ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('voice.personMenu', { name })}
          hitSlop={8}
          onPress={onMenu}
          style={[styles.menu, { backgroundColor: 'rgba(0,0,0,0.45)' }]}
        >
          <Text style={styles.menuText}>{MENU_GLYPH}</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/** Asks the camera client for the high layer on the cameras shown large, once sizes hold. */
function useHighLayers(
  client: CameraClient<MediaStreamTrack> | null,
  widths: ReadonlyMap<string, number> | null,
): void {
  const previous = useRef<ReadonlySet<string>>(new Set());
  const latest = useRef(widths);
  useEffect(() => {
    latest.current = widths;
  });
  const key = widths
    ? [...widths].map(([id, width]) => `${id}:${Math.round(width / 10)}`).join('|')
    : null;
  useEffect(() => {
    if (!client || key === null) return;
    const timer = setTimeout(() => {
      const next = pickHighLayers(latest.current ?? new Map(), previous.current);
      previous.current = next;
      client.setHighLayers(next);
    }, LAYER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [client, key]);
  useEffect(
    () => () => {
      previous.current = new Set();
      client?.setHighLayers([]);
    },
    [client],
  );
}

/** The stage's measured size (the box the parent gives it). */
export function useStageSize(): [
  (e: { nativeEvent: { layout: { width: number; height: number } } }) => void,
  { width: number; height: number },
] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  return [
    (e) => {
      const width = Math.floor(e.nativeEvent.layout.width);
      const height = Math.floor(e.nativeEvent.layout.height);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    },
    size,
  ];
}

const styles = StyleSheet.create({
  stage: { overflow: 'hidden' },
  fill: { flex: 1, gap: GAP },
  rowDirection: { flexDirection: 'row' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  gallery: { gap: GAP, alignItems: 'center' },
  line: { flexDirection: 'row', gap: GAP, justifyContent: 'center' },
  strip: { gap: GAP, alignItems: 'flex-start', flexGrow: 1, justifyContent: 'center' },
  pip: { position: 'absolute', right: 8, bottom: 8 },
  tile: { borderRadius: radius.card, overflow: 'hidden', justifyContent: 'flex-end' },
  avatarBox: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  label: { padding: 6, flexDirection: 'row', alignItems: 'center', gap: 4 },
  flexName: { flexShrink: 1 },
  name: { fontFamily: font.medium, fontSize: 13 },
  nameSmall: { fontSize: 11 },
  state: { fontFamily: font.regular, fontSize: 11 },
  menu: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuText: { color: '#fff', fontSize: 18, lineHeight: 20, fontFamily: font.semibold },
});
