// SPDX-License-Identifier: AGPL-3.0-only
import { DotsThree, Users } from 'phosphor-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import type { Member } from '@openlive/client';
import { OfflineHint } from '../../components/OfflineHint.tsx';
import {
  Avatar,
  Badge,
  Body,
  Button,
  Card,
  SectionLabel,
  Segmented,
} from '../../components/ui.tsx';
import { EmptyState, Sheet } from '../../components/ui/index.ts';
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import { type MemberActions, memberActions, sortMembers } from '../../lib/space-view.ts';
import { useMembers, useSpaceActions } from '../../space-queries.ts';
import { font, useTheme } from '../../theme.ts';
import {
  confirmAction,
  Labeled,
  QueryFailure,
  type SectionProps,
  useErrorToast,
} from './shared.tsx';

/** Members with their role; change role, transfer, remove and ban where the role allows. */
export function MembersSection({ origin, space, selfId }: SectionProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const members = useMembers(origin, space.id);
  if (members.isPending && members.fetchStatus !== 'paused') {
    return <Skeleton height={112} />;
  }
  if (members.data === undefined) {
    return members.isError ? (
      <QueryFailure error={members.error} onRetry={() => void members.refetch()} />
    ) : (
      <Body muted>{t('mobile.loading')}</Body>
    );
  }
  const { active, banned } = sortMembers(members.data);
  if (active.length === 0) {
    return (
      <EmptyState
        icon={<Users size={22} color={colors.mutedForeground} />}
        title={t('space.members.empty.title')}
        description={t('space.members.empty.description')}
      />
    );
  }
  return (
    <>
      <OfflineHint hasData />
      {active.map((m) => (
        <MemberCard key={m.userId} origin={origin} space={space} selfId={selfId} member={m} />
      ))}
      {banned.length > 0 ? (
        <>
          <SectionLabel>{t('space.members.banned')}</SectionLabel>
          {banned.map((m) => (
            <MemberCard key={m.userId} origin={origin} space={space} selfId={selfId} member={m} />
          ))}
        </>
      ) : null}
    </>
  );
}

function MemberCard({ origin, space, selfId, member }: SectionProps & { member: Member }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const actions = useSpaceActions(origin, space.id);
  const onError = useErrorToast();
  const [menu, setMenu] = useState(false);
  const can = memberActions(space.role, selfId, member);
  const name = member.displayName;
  const date = (at: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(at);

  const confirm = (kind: 'ban' | 'remove' | 'transfer') =>
    confirmAction(t, {
      title: t(`space.members.confirm.${kind}.title`, { name }),
      message: t(`space.members.confirm.${kind}.description`, { name }),
      action: t(`space.members.confirm.${kind}.action`),
      destructive: kind !== 'transfer',
      onConfirm: () => {
        if (kind === 'ban')
          actions.setBanned.mutate({ userId: member.userId, banned: true }, { onError });
        else if (kind === 'remove') actions.removeMember.mutate(member.userId, { onError });
        else actions.transfer.mutate(member.userId, { onError });
      },
    });

  return (
    <Card>
      <View style={styles.row}>
        <Avatar name={name} url={member.avatarUrl} size={40} />
        <View style={styles.grow}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {name}
            {member.userId === selfId ? ` ${t('space.members.you')}` : ''}
          </Text>
          <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
            {member.bannedAt !== null
              ? t('space.members.bannedAt', { date: date(member.bannedAt) })
              : t('space.members.joinedAt', { date: date(member.joinedAt) })}
          </Text>
        </View>
        <Badge tone="outline" label={t(`roles.${member.role}`)} />
        {can.menu ? (
          <Button
            size={ICON}
            variant="ghost"
            label={t('space.members.actions', { name })}
            icon={<DotsThree size={22} weight="bold" color={colors.foreground} />}
            onPress={() => setMenu(true)}
          />
        ) : null}
      </View>
      {can.menu ? (
        <MemberMenu
          open={menu}
          onClose={() => setMenu(false)}
          name={name}
          can={can}
          current={member.role}
          onRole={(role) => actions.changeRole.mutate({ userId: member.userId, role }, { onError })}
          onConfirm={confirm}
          onUnban={() =>
            actions.setBanned.mutate({ userId: member.userId, banned: false }, { onError })
          }
        />
      ) : null}
    </Card>
  );
}

const TRANSFER = 'transfer';
const REMOVE = 'remove';
const BAN = 'ban';
const ICON = 'icon';

/** The member's menu (the web's dropdown) as a sheet: the role to give, then the actions. */
function MemberMenu({
  open,
  onClose,
  name,
  can,
  current,
  onRole,
  onConfirm,
  onUnban,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  can: MemberActions;
  current: Member['role'];
  onRole: (role: 'admin' | 'member' | 'guest') => void;
  onConfirm: (kind: 'ban' | 'remove' | 'transfer') => void;
  onUnban: () => void;
}) {
  const { t } = useTranslation();
  const askTransfer = () => onConfirm(TRANSFER);
  const askRemove = () => onConfirm(REMOVE);
  const askBan = () => onConfirm(BAN);
  const then = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <Sheet open={open} onClose={onClose} title={name}>
      {can.roles.length > 0 ? (
        <Labeled label={t('space.members.role')}>
          <Segmented
            options={can.roles.map((role) => ({ value: role, label: t(`roles.${role}`) }))}
            value={current as 'admin' | 'member' | 'guest'}
            onChange={(role) => {
              if (role !== current) then(() => onRole(role))();
            }}
          />
        </Labeled>
      ) : null}
      {can.transfer ? (
        <Button variant="outline" label={t('space.members.transfer')} onPress={then(askTransfer)} />
      ) : null}
      {can.remove ? (
        <Button variant="outline" label={t('space.members.remove')} onPress={then(askRemove)} />
      ) : null}
      {can.ban ? (
        <Button variant="destructive" label={t('space.members.ban')} onPress={then(askBan)} />
      ) : null}
      {can.unban ? (
        <Button variant="outline" label={t('space.members.unban')} onPress={then(onUnban)} />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, gap: 1 },
  name: { fontFamily: font.medium, fontSize: 15 },
  meta: { fontFamily: font.regular, fontSize: 13 },
});
