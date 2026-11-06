// SPDX-License-Identifier: AGPL-3.0-only
import { isManager, type Member, type Room, type Space } from '@openlive/client';
import type { Role, RoomCapabilities } from '@openlive/protocol';
import {
  Archive,
  DotsThree,
  Key,
  Plus,
  ShareNetwork,
  SlidersHorizontal,
} from 'phosphor-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, StyleSheet, Text, View } from 'react-native';
import {
  Avatar,
  Banner,
  Body,
  Button,
  Card,
  Row,
  SectionLabel,
  Segmented,
  Toggle,
} from '../../components/ui.tsx';
import { Sheet, Skeleton } from '../../components/ui/index.ts';
import { toast } from '../../notices/notify.ts';
import { useScope } from '../../queries.ts';
import {
  useMembers,
  useRoomAccess,
  useRoomActions,
  useRoomInfo,
  useSpace,
} from '../../space-queries.ts';
import {
  chatFormOf,
  type ChatForm,
  endsStreams,
  featuresPatch,
  joinLink,
  RETENTION_OPTIONS,
  roomMenu,
  templateOf,
} from '../../lib/room-menu.ts';
import { ceilingOf, type Template, TEMPLATES } from '../../lib/capabilities.ts';
import { font, useTheme } from '../../theme.ts';
import { TemplatePicker } from '../space/RoomsSection.tsx';
import {
  confirmAction,
  ErrorLine,
  Labeled,
  QueryFailure,
  SwitchRow,
  useErrorToast,
} from '../space/shared.tsx';

type View_ = 'menu' | 'features' | 'access';
const MENU: View_ = 'menu';
const FEATURES: View_ = 'features';
const ACCESS: View_ = 'access';

/**
 * The room's actions as a sheet from the header (the web's RoomView header buttons): the quick
 * room's code and link to share, the features, who sees a restricted room, and archiving or
 * ending the room. Nothing here touches the stream player or the voice session.
 */
export function RoomMenu({
  origin,
  spaceId,
  roomId,
  role,
  ended,
  liveStreams,
  onClosed,
}: {
  origin: string;
  spaceId: string;
  roomId: string;
  /** The caller's role in the room (the room socket's `you`), when known. */
  role: Role | null | undefined;
  ended: boolean;
  liveStreams: number;
  /** The room was archived or ended by this person: leave its screen. */
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const scope = useScope(origin);
  const info = useRoomInfo(origin, roomId);
  const space = useSpace(origin, spaceId);
  const [view, setView] = useState<View_ | null>(null);
  const room = info.data;
  if (!room || !scope) return null;
  const effectiveRole = role ?? space.data?.role ?? null;
  const menu = roomMenu({ role: effectiveRole, selfId: scope.userId, room, ended });
  if (menu.empty) return null;
  const close = () => setView(null);
  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        label={t('mobile.room.menu')}
        icon={<DotsThree size={26} weight="bold" color={colors.foreground} />}
        onPress={() => setView(MENU)}
      />
      <MenuSheet
        open={view === MENU}
        onClose={close}
        origin={origin}
        room={room}
        menu={menu}
        onView={setView}
        onClosed={() => (close(), onClosed())}
      />
      {menu.features ? (
        <FeaturesSheet
          open={view === FEATURES}
          onClose={close}
          origin={origin}
          room={room}
          space={space.data ?? null}
          liveStreams={liveStreams}
        />
      ) : null}
      {menu.access ? (
        <AccessSheet open={view === ACCESS} onClose={close} origin={origin} room={room} />
      ) : null}
    </>
  );
}

function MenuSheet({
  open,
  onClose,
  origin,
  room,
  menu,
  onView,
  onClosed,
}: {
  open: boolean;
  onClose: () => void;
  origin: string;
  room: Room;
  menu: ReturnType<typeof roomMenu>;
  onView: (view: View_) => void;
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const actions = useRoomActions(origin, room);
  const errorToast = useErrorToast();
  const kind = room.kind === 'quick' ? 'end' : 'archive';
  const share = (message: string) => void Share.share({ message }).catch(() => {});

  const ask = () =>
    confirmAction(t, {
      title: t(`room.${kind}.title`, { name: room.name }),
      message: t(`room.${kind}.description`),
      action: t(`room.${kind}.action`),
      onConfirm: () =>
        actions.close.mutate(undefined, {
          onSuccess: () => (toast(t(`mobile.room.${kind}Done`)), onClosed()),
          onError: errorToast,
        }),
    });

  return (
    <Sheet open={open} onClose={onClose} title={room.name}>
      {menu.code && room.code ? (
        <>
          <SectionLabel>{t('room.code.label')}</SectionLabel>
          <Card>
            <Text selectable style={[styles.code, { color: colors.foreground }]}>
              {room.code}
            </Text>
            <View style={styles.row}>
              <View style={styles.grow}>
                <Button
                  label={t('mobile.room.shareCode')}
                  accessibilityLabel={t('mobile.room.shareCodeA11y')}
                  variant="outline"
                  icon={<ShareNetwork size={18} color={colors.foreground} />}
                  onPress={() => share(room.code ?? '')}
                />
              </View>
              <View style={styles.grow}>
                <Button
                  label={t('mobile.room.shareLink')}
                  accessibilityLabel={t('mobile.room.shareLinkA11y')}
                  variant="outline"
                  icon={<ShareNetwork size={18} color={colors.foreground} />}
                  onPress={() => share(joinLink(origin, room.code ?? ''))}
                />
              </View>
            </View>
          </Card>
        </>
      ) : null}
      {menu.features ? (
        <Button
          label={t('room.features.action')}
          variant="outline"
          icon={<SlidersHorizontal size={18} color={colors.foreground} />}
          onPress={() => onView(FEATURES)}
        />
      ) : null}
      {menu.access ? (
        <Button
          label={t('room.access.action')}
          variant="outline"
          icon={<Key size={18} color={colors.foreground} />}
          onPress={() => onView(ACCESS)}
        />
      ) : null}
      {menu.close ? (
        <Button
          label={t(`room.${kind}.action`)}
          variant="destructive"
          icon={<Archive size={18} color={colors.destructive} />}
          busy={actions.close.isPending}
          onPress={ask}
        />
      ) : null}
    </Sheet>
  );
}

function FeaturesSheet({
  open,
  onClose,
  origin,
  room,
  space,
  liveStreams,
}: {
  open: boolean;
  onClose: () => void;
  origin: string;
  room: Room;
  space: Space | null;
  liveStreams: number;
}) {
  const { t } = useTranslation();
  const actions = useRoomActions(origin, room);
  const stored: RoomCapabilities = room.settings.capabilities ?? TEMPLATES.streamOnly;
  const storedChat = chatFormOf(room.settings);
  const ceiling = ceilingOf(space?.effectiveSettings);
  const [value, setValue] = useState<RoomCapabilities>(stored);
  const [template, setTemplate] = useState<Template>(() => templateOf(stored));
  const [chat, setChat] = useState<ChatForm>(storedChat);
  const patch = featuresPatch({ stored, value, storedChat, chat, ceiling });
  const quick = room.kind === 'quick';
  const chatCeiling = space?.effectiveSettings.chatRetentionDays ?? 90;

  const reset = () => {
    setValue(stored);
    setTemplate(templateOf(stored));
    setChat(storedChat);
    actions.update.reset();
  };
  const close = () => {
    onClose();
    reset();
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('room.features.title')}
      description={t('room.features.description')}
    >
      <TemplatePicker
        template={template}
        capabilities={value}
        ceiling={ceiling}
        onTemplate={(next) => {
          setTemplate(next);
          if (next !== 'custom') setValue({ ...TEMPLATES[next] });
        }}
        onCapabilities={setValue}
      />
      {value.text ? (
        <>
          <Labeled
            label={t('chat.settings.retention')}
            hint={
              quick
                ? t('chat.retention.quick')
                : chat.retention === 0
                  ? t('chat.settings.noHistoryHint')
                  : t('chat.settings.retentionHint')
            }
          >
            {quick ? null : (
              <Segmented
                options={RETENTION_OPTIONS.filter(
                  (d) => d <= chatCeiling || d === chat.retention,
                ).map((d) => ({
                  value: String(d),
                  label:
                    d === 0 ? t('chat.settings.noHistory') : t('chat.settings.days', { count: d }),
                }))}
                value={String(chat.retention)}
                onChange={(v) => {
                  const days = RETENTION_OPTIONS.find((d) => String(d) === v);
                  if (days !== undefined) setChat({ ...chat, retention: days });
                }}
              />
            )}
          </Labeled>
          <SwitchRow
            label={t('chat.settings.guestsCanWrite')}
            hint={t('chat.settings.guestsCanWriteHint')}
          >
            <Toggle
              label={t('chat.settings.guestsCanWrite')}
              value={chat.guestsCanWrite}
              onValueChange={(on) => setChat({ ...chat, guestsCanWrite: on })}
            />
          </SwitchRow>
        </>
      ) : null}
      {endsStreams(stored, value, liveStreams) ? (
        <Banner tone="destructive">{t('room.features.streamOff')}</Banner>
      ) : null}
      <ErrorLine error={actions.update.error} />
      <Button
        label={t('common.save')}
        disabled={patch === null}
        busy={actions.update.isPending}
        onPress={() =>
          patch &&
          actions.update.mutate(patch, {
            onSuccess: () => {
              toast(t('room.features.saved'));
              close();
            },
          })
        }
      />
    </Sheet>
  );
}

function AccessSheet({
  open,
  onClose,
  origin,
  room,
}: {
  open: boolean;
  onClose: () => void;
  origin: string;
  room: Room;
}) {
  const { t } = useTranslation();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('room.access.title', { name: room.name })}
      description={t('room.access.description')}
    >
      {open ? <AccessList origin={origin} room={room} /> : null}
    </Sheet>
  );
}

/** The web's AccessList: who has a grant (guests can get the stream permission) and who to add. */
function AccessList({ origin, room }: { origin: string; room: Room }) {
  const { t } = useTranslation();
  const access = useRoomAccess(origin, room.id);
  const members = useMembers(origin, room.spaceId);
  const actions = useRoomActions(origin, room);
  if (access.isPending || members.isPending) return <Skeleton height={112} />;
  if (access.isError || members.isError) {
    return (
      <QueryFailure
        error={access.error ?? members.error}
        onRetry={() => (void access.refetch(), void members.refetch())}
      />
    );
  }
  const byId = new Map<string, Member>(members.data.map((m) => [m.userId, m]));
  const granted = access.data.filter((a) => a.canView);
  const grantedIds = new Set(granted.map((a) => a.userId));
  const candidates = members.data.filter(
    (m) => m.bannedAt === null && !isManager(m.role) && !grantedIds.has(m.userId),
  );
  const busy = actions.grant.isPending || actions.revoke.isPending;
  return (
    <>
      <ErrorLine error={actions.grant.error ?? actions.revoke.error} />
      <SectionLabel>{t('room.access.granted')}</SectionLabel>
      {granted.length === 0 ? <Body muted>{t('room.access.none')}</Body> : null}
      {granted.map((entry) => {
        const member = byId.get(entry.userId);
        const name = member?.displayName ?? t('room.access.roomGuest');
        // Members stream anyway; the per-room stream permission is for guests.
        const guest = !member || member.role === 'guest';
        return (
          <Card key={entry.userId}>
            <Row>
              <Avatar name={name} url={member?.avatarUrl ?? null} size={32} />
              <Text style={[styles.name, styles.grow]} numberOfLines={1}>
                {name}
              </Text>
              <Button
                label={t('room.access.revoke')}
                accessibilityLabel={t('room.access.revokeLabel', { name })}
                variant="outline"
                compact
                disabled={busy}
                onPress={() => actions.revoke.mutate(entry.userId)}
              />
            </Row>
            {guest ? (
              <SwitchRow label={t('room.access.canStream')}>
                <Toggle
                  label={t('room.access.canStream')}
                  value={entry.canStream}
                  onValueChange={(canStream) =>
                    !busy &&
                    actions.grant.mutate({ userId: entry.userId, canView: true, canStream })
                  }
                />
              </SwitchRow>
            ) : null}
          </Card>
        );
      })}
      {candidates.length > 0 ? (
        <>
          <SectionLabel>{t('room.access.add')}</SectionLabel>
          {candidates.map((member) => (
            <Card key={member.userId}>
              <Row>
                <Avatar name={member.displayName} url={member.avatarUrl} size={32} />
                <Text style={[styles.name, styles.grow]} numberOfLines={1}>
                  {member.displayName}
                </Text>
                <Button
                  label={t('room.access.grant')}
                  accessibilityLabel={t('room.access.grantLabel', { name: member.displayName })}
                  variant="outline"
                  compact
                  icon={<Plus size={16} />}
                  disabled={actions.grant.isPending}
                  onPress={() => actions.grant.mutate({ userId: member.userId, canView: true })}
                />
              </Row>
            </Card>
          ))}
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  code: { fontFamily: font.semibold, fontSize: 22, letterSpacing: 1, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
  name: { fontFamily: font.medium, fontSize: 15 },
});
