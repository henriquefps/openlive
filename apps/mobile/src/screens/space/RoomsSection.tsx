// SPDX-License-Identifier: AGPL-3.0-only
import { spaceAbilities, unreadLabel } from '@openlive/client';
import type { RoomCapabilities, RoomVisibility } from '@openlive/protocol';
import type { TFunction } from 'i18next';
import { DoorOpen, Lightning, Lock, Plus } from 'phosphor-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { OfflineHint } from '../../components/OfflineHint.tsx';
import {
  Badge,
  Banner,
  Body,
  Button,
  Card,
  Field,
  Row,
  SectionLabel,
  Segmented,
  Toggle,
} from '../../components/ui.tsx';
import { EmptyState, Sheet } from '../../components/ui/index.ts';
import { useApi, useSpacePresence } from '../../hooks.ts';
import {
  aboveCeiling,
  CAPABILITIES,
  type Template,
  TEMPLATE_IDS,
  TEMPLATES,
  ceilingOf,
  firstTemplate,
  toggle,
} from '../../lib/capabilities.ts';
import { namesWithMore, type RoomRow, roomRows, streamerNames } from '../../lib/presence.ts';
import { checkFixedRoom, formatRemaining, openRooms, quickCode } from '../../lib/space-view.ts';
import { toast } from '../../notices/notify.ts';
import { useRooms, useUnread } from '../../queries.ts';
import { useSpaceActions } from '../../space-queries.ts';
import { font, useTheme } from '../../theme.ts';
import {
  ErrorLine,
  Hint,
  Labeled,
  type SectionProps,
  QueryFailure,
  SwitchRow,
  useNow,
} from './shared.tsx';

const SPACE = 'space';
const RESTRICTED = 'restricted';

/** How many names a room row spells out before "+N more". */
const NAMES = 3;

/**
 * Rooms: fixed rooms and open quick rooms with who is in voice, who streams (the space socket,
 * live) and unread chat; create a fixed room or open a quick room (the web's RoomsTab and the
 * header buttons of its SpacePage).
 */
export function RoomsSection({
  origin,
  space,
  refreshKey,
  onOpenRoom,
}: SectionProps & {
  /** Changes when a room was closed, so the unread counts are fetched again. */
  refreshKey: number;
  onOpenRoom: (roomId: string, roomName: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const abilities = spaceAbilities(space);
  const api = useApi(origin);
  const presence = useSpacePresence(api, origin, space.id);
  const rooms = useRooms(origin, space.id);
  // Unread counts are a separate call: a failure there must not hide the rooms.
  const unread = useUnread(origin, space.id);
  const actions = useSpaceActions(origin, space.id);
  const now = useNow(30_000);
  const [creating, setCreating] = useState(false);

  const refetchUnread = unread.refetch;
  useEffect(() => {
    if (refreshKey > 0) void refetchUnread();
  }, [refreshKey, refetchUnread]);

  const rows = useMemo(
    () =>
      rooms.data ? roomRows(openRooms(rooms.data, now), presence.rooms, unread.data ?? {}) : [],
    [rooms.data, presence.rooms, unread.data, now],
  );
  const fixed = rows.filter((r) => r.room.kind === 'fixed');
  const quick = rows.filter((r) => r.room.kind === 'quick');

  const openQuick = () =>
    actions.createQuickRoom.mutate(undefined, {
      onSuccess: ({ room, code }) => {
        toast(t('space.rooms.quickCreated', { code }));
        onOpenRoom(room.id, room.name);
      },
    });

  // An error only replaces the rooms when there is nothing saved to show.
  const failed = rooms.data === undefined && rooms.isError ? rooms.error : null;
  return (
    <>
      {abilities.createQuickRoom || abilities.createFixedRoom ? (
        <View style={styles.actions}>
          {abilities.createFixedRoom ? (
            <View style={styles.action}>
              <Button
                label={t('space.rooms.createAction')}
                icon={<Plus size={18} color={colors.primaryForeground} />}
                onPress={() => setCreating(true)}
              />
            </View>
          ) : null}
          {abilities.createQuickRoom ? (
            <View style={styles.action}>
              <Button
                label={t('space.rooms.quickAction')}
                variant="outline"
                icon={<Lightning size={18} color={colors.foreground} />}
                busy={actions.createQuickRoom.isPending}
                onPress={openQuick}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      <ErrorLine error={actions.createQuickRoom.error} />
      <OfflineHint hasData={rooms.data !== undefined} />
      {presence.status === 'reconnecting' ? (
        <Banner>{t('mobile.space.reconnecting')}</Banner>
      ) : null}
      {presence.status === 'ended' ? (
        <Banner tone="muted">{t('mobile.space.presenceEnded')}</Banner>
      ) : null}
      {failed ? <QueryFailure error={failed} onRetry={() => void rooms.refetch()} /> : null}
      {rooms.isPending && rooms.fetchStatus !== 'paused' ? (
        <Body muted>{t('mobile.loading')}</Body>
      ) : null}
      {rooms.data !== undefined ? (
        <>
          <SectionLabel>{t('space.rooms.fixed')}</SectionLabel>
          {fixed.length === 0 ? (
            <EmptyState
              icon={<DoorOpen size={22} color={colors.mutedForeground} />}
              title={t('space.rooms.emptyFixed.title')}
              description={t('space.rooms.emptyFixed.description')}
            />
          ) : (
            fixed.map((row) => (
              <RoomCard
                key={row.room.id}
                row={row}
                now={now}
                onPress={() => onOpenRoom(row.room.id, row.room.name)}
              />
            ))
          )}
          <SectionLabel>{t('space.rooms.quick')}</SectionLabel>
          {quick.length === 0 ? (
            <Hint>{t('space.rooms.emptyQuick')}</Hint>
          ) : (
            quick.map((row) => (
              <RoomCard
                key={row.room.id}
                row={row}
                now={now}
                onPress={() => onOpenRoom(row.room.id, row.room.name)}
              />
            ))
          )}
        </>
      ) : null}
      {abilities.createFixedRoom ? (
        <CreateRoomSheet
          open={creating}
          onClose={() => setCreating(false)}
          origin={origin}
          space={space}
          onCreated={(roomId, roomName) => {
            setCreating(false);
            onOpenRoom(roomId, roomName);
          }}
        />
      ) : null}
    </>
  );
}

function RoomCard({ row, now, onPress }: { row: RoomRow; now: number; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { room } = row;
  const voice = namesWithMore(
    row.voice.map((v) => v.displayName),
    NAMES,
  );
  const live = namesWithMore(streamerNames(row.live), NAMES);
  const quiet = row.voice.length === 0 && row.live.length === 0;
  const Icon =
    room.kind === 'quick' ? Lightning : room.visibility === 'restricted' ? Lock : DoorOpen;
  return (
    <Card onPress={onPress}>
      <Row>
        <Icon size={18} color={colors.mutedForeground} />
        <View style={styles.grow}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {room.name}
          </Text>
          {room.kind === 'quick' ? (
            <Text style={[styles.meta, styles.mono, { color: colors.mutedForeground }]}>
              {quickCode(room)}
              {room.expiresAt !== null ? ` · ${formatRemaining(room.expiresAt - now)}` : ''}
            </Text>
          ) : null}
          {quiet ? (
            <Text style={[styles.meta, { color: colors.mutedForeground }]}>
              {t('mobile.space.quiet')}
            </Text>
          ) : null}
        </View>
        {room.visibility === 'restricted' ? (
          <Badge tone="outline" label={t('space.rooms.restricted')} />
        ) : null}
        {row.live.length > 0 ? <Badge tone="live" label={t('mobile.space.live')} /> : null}
        {row.unread > 0 ? (
          <View accessibilityLabel={t('chat.unread', { count: row.unread })}>
            <Badge label={unreadLabel(row.unread)} tone="destructive" />
          </View>
        ) : null}
      </Row>
      {row.live.length > 0 ? (
        <Text style={[styles.meta, { color: colors.foreground }]} numberOfLines={2}>
          {t('mobile.space.streaming', {
            names: joinNames(live.shown, live.more, t('mobile.space.someone'), t),
          })}
        </Text>
      ) : null}
      {row.voice.length > 0 ? (
        <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={2}>
          {t('mobile.space.inVoice', {
            names: joinNames(voice.shown, voice.more, '', t),
          })}
        </Text>
      ) : null}
    </Card>
  );
}

function joinNames(shown: string[], more: number, fallback: string, t: TFunction): string {
  const list = shown.length > 0 ? shown.join(', ') : fallback;
  return more > 0 ? `${list}, ${t('app.sidebar.morePeople', { count: more })}` : list;
}

/** The web's CreateFixedRoomDialog: name, address, who sees it, what the room has. */
function CreateRoomSheet({
  open,
  onClose,
  origin,
  space,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  origin: string;
  space: SectionProps['space'];
  onCreated: (roomId: string, roomName: string) => void;
}) {
  const { t } = useTranslation();
  const actions = useSpaceActions(origin, space.id);
  const create = actions.createFixedRoom;
  const ceiling = ceilingOf(space.effectiveSettings);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<RoomVisibility>(SPACE);
  const [template, setTemplate] = useState<Template>(() => firstTemplate(ceiling));
  const [capabilities, setCapabilities] = useState<RoomCapabilities>(() => ({
    ...TEMPLATES[firstTemplate(ceiling)],
  }));
  const check = checkFixedRoom({ name, slug, capabilities }, ceiling);
  const visibilityOptions = [
    { value: SPACE, label: t('space.rooms.visibility.space') },
    { value: RESTRICTED, label: t('space.rooms.visibility.restricted') },
  ] as const;

  const reset = () => {
    setName('');
    setSlug(null);
    setVisibility(SPACE);
    setTemplate(firstTemplate(ceiling));
    setCapabilities({ ...TEMPLATES[firstTemplate(ceiling)] });
    create.reset();
  };
  const close = () => {
    onClose();
    reset();
  };

  const submit = () =>
    create.mutate(
      { name: name.trim(), slug: check.slug, visibility, settings: { capabilities } },
      {
        onSuccess: (room) => {
          reset();
          onCreated(room.id, room.name);
        },
      },
    );

  const pick = (next: Template) => {
    setTemplate(next);
    if (next !== 'custom') setCapabilities({ ...TEMPLATES[next] });
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('space.rooms.create.title')}
      description={t('space.rooms.create.description')}
    >
      <Field
        label={t('space.rooms.create.name')}
        value={name}
        onChangeText={setName}
        maxLength={80}
        autoFocus
      />
      <Field
        label={t('space.rooms.create.slug')}
        value={check.slug}
        onChangeText={(v) => setSlug(v.toLowerCase())}
        maxLength={48}
        autoCapitalize="none"
        autoCorrect={false}
        invalid={check.slug !== '' && !check.slugValid}
      />
      <Hint>
        {t('spaces.create.slugHint', { path: `/s/${space.slug}/r/${check.slug || '…'}` })}
      </Hint>
      <Labeled
        label={t('space.rooms.create.visibility')}
        hint={t(`space.rooms.visibility.${visibility}Hint`)}
      >
        <Segmented options={visibilityOptions} value={visibility} onChange={setVisibility} />
      </Labeled>
      <Labeled label={t('capabilities.templates.label')}>
        <TemplatePicker
          template={template}
          capabilities={capabilities}
          ceiling={ceiling}
          onTemplate={pick}
          onCapabilities={setCapabilities}
        />
      </Labeled>
      <ErrorLine error={create.error} />
      <Button
        label={t('space.rooms.create.submit')}
        disabled={!check.valid}
        busy={create.isPending}
        onPress={submit}
      />
    </Sheet>
  );
}

/** The web's TemplatePicker: the templates the space allows, and Custom with one switch each. */
export function TemplatePicker({
  template,
  capabilities,
  ceiling,
  onTemplate,
  onCapabilities,
}: {
  template: Template;
  capabilities: RoomCapabilities;
  ceiling: RoomCapabilities;
  onTemplate: (next: Template) => void;
  onCapabilities: (next: RoomCapabilities) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const allowed = (id: Template) =>
    id === 'custom' || aboveCeiling(TEMPLATES[id], ceiling).length === 0;
  const ids = TEMPLATE_IDS.filter(allowed);
  return (
    <View style={styles.templates}>
      <Segmented
        options={ids
          .slice(0, 3)
          .map((id) => ({ value: id, label: t(`capabilities.templates.${id}.label`) }))}
        value={template}
        onChange={onTemplate}
      />
      {ids.length > 3 ? (
        <Segmented
          options={ids
            .slice(3)
            .map((id) => ({ value: id, label: t(`capabilities.templates.${id}.label`) }))}
          value={template}
          onChange={onTemplate}
        />
      ) : null}
      <Hint>{t(`capabilities.templates.${template}.description`)}</Hint>
      {template === 'custom'
        ? CAPABILITIES.map((key) => {
            const blocked = !ceiling[key];
            return (
              <SwitchRow
                key={key}
                label={t(`capabilities.${key}.label`)}
                hint={blocked ? t('capabilities.notAllowed') : t(`capabilities.${key}.description`)}
              >
                <Toggle
                  label={t(`capabilities.${key}.label`)}
                  value={capabilities[key]}
                  onValueChange={(on) => {
                    if (!blocked) onCapabilities(toggle(capabilities, key, on));
                  }}
                />
              </SwitchRow>
            );
          })
        : null}
      {template === 'custom' &&
      !(capabilities.stream || capabilities.voice || capabilities.text) ? (
        <Text style={[styles.meta, { color: colors.destructive }]}>
          {t('capabilities.atLeastOne')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
  grow: { flex: 1, gap: 2 },
  name: { fontFamily: font.medium, fontSize: 16 },
  meta: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: font.regular, fontVariant: ['tabular-nums'] },
  templates: { gap: 8 },
});
