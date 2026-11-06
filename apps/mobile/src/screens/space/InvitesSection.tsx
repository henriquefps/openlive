// SPDX-License-Identifier: AGPL-3.0-only
import { type Invite, spaceAbilities } from '@openlive/client';
import { EnvelopeSimple, Plus, ShareNetwork } from 'phosphor-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, StyleSheet, Text, View } from 'react-native';
import { Badge, Body, Button, Card, Field, Segmented, Toggle } from '../../components/ui.tsx';
import { EmptyState, Sheet } from '../../components/ui/index.ts';
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import {
  EXPIRY_HOURS,
  type InviteForm,
  inviteInput,
  inviteRoomName,
  inviteUrl,
  usesValid,
} from '../../lib/space-view.ts';
import { useRooms } from '../../queries.ts';
import { useInvites, useSpaceActions } from '../../space-queries.ts';
import { font, useTheme } from '../../theme.ts';
import {
  ErrorLine,
  Hint,
  Labeled,
  QueryFailure,
  type SectionProps,
  SwitchRow,
  useErrorToast,
} from './shared.tsx';

const SPACE = 'space';
const ROOM = 'room';
const GUEST = 'guest';
const MEMBER = 'member';

const INITIAL: InviteForm = {
  roomId: '',
  role: 'guest',
  canStream: false,
  requiresApproval: false,
  maxUses: '1',
  expiresInHours: 168,
};

/** Active invites: list, create (and share the link, shown once) and revoke. */
export function InvitesSection({ origin, space }: SectionProps) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const abilities = spaceAbilities(space);
  const canCreate = abilities.inviteGuests || abilities.inviteMembers;
  const invites = useInvites(origin, space.id);
  const rooms = useRooms(origin, space.id);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Hint>{t('space.invites.intro')}</Hint>
      {canCreate ? (
        <Button
          label={t('space.invites.create.action')}
          icon={<Plus size={18} color={colors.primaryForeground} />}
          onPress={() => setCreating(true)}
        />
      ) : null}
      {invites.isPending && invites.fetchStatus !== 'paused' ? <Skeleton height={112} /> : null}
      {invites.data === undefined && invites.isError ? (
        <QueryFailure error={invites.error} onRetry={() => void invites.refetch()} />
      ) : null}
      {invites.data?.length === 0 ? (
        <EmptyState
          icon={<EnvelopeSimple size={22} color={colors.mutedForeground} />}
          title={t('space.invites.empty.title')}
          description={t('space.invites.empty.description')}
        />
      ) : null}
      {invites.data?.map((invite) => (
        <InviteCard
          key={invite.id}
          origin={origin}
          spaceId={space.id}
          invite={invite}
          roomName={inviteRoomName(invite, rooms.data)}
          locale={i18n.language}
        />
      ))}
      {canCreate ? (
        <CreateInviteSheet
          open={creating}
          onClose={() => setCreating(false)}
          origin={origin}
          space={space}
        />
      ) : null}
    </>
  );
}

function InviteCard({
  origin,
  spaceId,
  invite,
  roomName,
  locale,
}: {
  origin: string;
  spaceId: string;
  invite: Invite;
  roomName: string | null;
  locale: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { revokeInvite } = useSpaceActions(origin, spaceId);
  const onError = useErrorToast();
  return (
    <Card>
      <View style={styles.badges}>
        <Text style={[styles.name, { color: colors.foreground }]}>
          {roomName
            ? t('space.invites.toRoom', { room: roomName })
            : t(`space.invites.toSpace.${invite.role}`)}
        </Text>
        {invite.canStream ? <Badge tone="outline" label={t('space.invites.canStream')} /> : null}
        {invite.requiresApproval ? (
          <Badge tone="outline" label={t('space.invites.approval')} />
        ) : null}
      </View>
      <Hint>
        {t('space.invites.meta', {
          uses: invite.uses,
          maxUses: invite.maxUses,
          date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            invite.expiresAt,
          ),
        })}
      </Hint>
      <Button
        label={t('space.invites.revoke')}
        variant="outline"
        busy={revokeInvite.isPending}
        onPress={() => revokeInvite.mutate(invite.id, { onError })}
      />
    </Card>
  );
}

/** The web's CreateInviteDialog: the form, then the link shown once. */
function CreateInviteSheet({
  open,
  onClose,
  origin,
  space,
}: {
  open: boolean;
  onClose: () => void;
  origin: string;
  space: SectionProps['space'];
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const abilities = spaceAbilities(space);
  const rooms = useRooms(origin, space.id);
  const { createInvite } = useSpaceActions(origin, space.id);
  const [form, setForm] = useState<InviteForm>(INITIAL);
  const [token, setToken] = useState<string | null>(null);
  const set = <K extends keyof InviteForm>(key: K, value: InviteForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const roomInvite = form.roomId !== '';
  const fixedRooms = rooms.data?.filter((r) => r.kind === 'fixed' && r.archivedAt === null) ?? [];
  const targetOptions = [
    { value: SPACE, label: t('space.invites.create.wholeSpace') },
    ...(fixedRooms.length > 0 ? [{ value: ROOM, label: t('mobile.space.targetRoom') }] : []),
  ];
  const roleOptions = [
    { value: GUEST, label: t('roles.guest') },
    ...(abilities.inviteMembers ? [{ value: MEMBER, label: t('roles.member') }] : []),
  ];
  const pickTarget = (target: string) =>
    set('roomId', target === SPACE ? '' : (fixedRooms[0]?.id ?? ''));
  const pickRoom = (roomId: string) => set('roomId', roomId);
  const pickRole = (role: string) => set('role', role === MEMBER ? MEMBER : GUEST);
  const setCanStream = (on: boolean) => set('canStream', on);
  const setApproval = (on: boolean) => set('requiresApproval', on);
  const setMaxUses = (text: string) => set('maxUses', text);
  const pickExpiry = (hours: string) => set('expiresInHours', Number(hours));

  const close = () => {
    onClose();
    setForm(INITIAL);
    setToken(null);
    createInvite.reset();
  };
  const link = token ? inviteUrl(origin, token) : '';
  const share = () =>
    // The system share sheet copies, messages or mails the link (no clipboard module is needed).
    void Share.share({ message: link }).catch(() => undefined);

  if (token) {
    return (
      <Sheet
        open={open}
        onClose={close}
        title={t('space.invites.created.title')}
        description={t('space.invites.created.description')}
      >
        <Labeled label={t('space.invites.created.link')}>
          <Text
            selectable
            accessibilityLabel={t('space.invites.created.link')}
            style={[
              styles.link,
              {
                color: colors.foreground,
                backgroundColor: colors.muted,
                borderColor: colors.border,
              },
            ]}
          >
            {link}
          </Text>
        </Labeled>
        <Button
          label={t('mobile.space.share')}
          icon={<ShareNetwork size={18} color={colors.primaryForeground} />}
          onPress={share}
        />
        <Card>
          <Text style={[styles.name, { color: colors.foreground }]}>
            {t('space.invites.created.onceTitle')}
          </Text>
          <Body muted>{t('space.invites.created.once')}</Body>
        </Card>
        <Button label={t('common.done')} variant="outline" onPress={close} />
      </Sheet>
    );
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('space.invites.create.title')}
      description={t('space.invites.create.description')}
    >
      <Labeled
        label={t('space.invites.create.target')}
        hint={roomInvite ? t('space.invites.create.roomHint') : t('space.invites.create.spaceHint')}
      >
        <Segmented
          options={targetOptions}
          value={roomInvite ? ROOM : SPACE}
          onChange={pickTarget}
        />
        {roomInvite
          ? fixedRooms.map((room) => (
              <Button
                key={room.id}
                size="sm"
                variant={form.roomId === room.id ? 'default' : 'outline'}
                label={t('space.invites.toRoom', { room: room.name })}
                onPress={() => pickRoom(room.id)}
              />
            ))
          : null}
      </Labeled>
      {!roomInvite ? (
        <Labeled
          label={t('space.invites.create.role')}
          hint={t(`space.invites.create.roleHint.${form.role}`)}
        >
          <Segmented options={roleOptions} value={form.role} onChange={pickRole} />
        </Labeled>
      ) : (
        <SwitchRow
          label={t('space.invites.create.canStream')}
          hint={t('space.invites.create.canStreamHint')}
        >
          <Toggle
            label={t('space.invites.create.canStream')}
            value={form.canStream}
            onValueChange={setCanStream}
          />
        </SwitchRow>
      )}
      <SwitchRow
        label={t('space.invites.create.approval')}
        hint={t('space.invites.create.approvalHint')}
      >
        <Toggle
          label={t('space.invites.create.approval')}
          value={form.requiresApproval}
          onValueChange={setApproval}
        />
      </SwitchRow>
      <Field
        label={t('space.invites.create.maxUses')}
        value={form.maxUses}
        onChangeText={setMaxUses}
        keyboardType="number-pad"
        invalid={!usesValid(form.maxUses)}
      />
      <Labeled label={t('space.invites.create.expiry')}>
        <Segmented
          options={EXPIRY_HOURS.map((h) => ({
            value: String(h),
            label: t(`space.invites.create.expiryOption.${h}`),
          }))}
          value={String(form.expiresInHours)}
          onChange={pickExpiry}
        />
      </Labeled>
      <ErrorLine error={createInvite.error} />
      <Button
        label={t('space.invites.create.submit')}
        disabled={!usesValid(form.maxUses)}
        busy={createInvite.isPending}
        onPress={() =>
          createInvite.mutate(inviteInput(form), { onSuccess: (result) => setToken(result.token) })
        }
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  name: { fontFamily: font.medium, fontSize: 15 },
  link: {
    fontFamily: font.regular,
    fontSize: 13,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
});
