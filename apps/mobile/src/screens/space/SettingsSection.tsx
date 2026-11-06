// SPDX-License-Identifier: AGPL-3.0-only
import { spaceAbilities } from '@openlive/client';
import type { RoomCapabilities } from '@openlive/protocol';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Card, Field, Heading, Toggle } from '../../components/ui.tsx';
import {
  aboveCeiling,
  ALL_CAPABILITIES,
  CAPABILITIES,
  ceilingOf,
  isValidCapabilities,
  sameCapabilities,
  toggle,
} from '../../lib/capabilities.ts';
import {
  currentLimits,
  invalidLimits,
  type LimitKey,
  LIMITS,
  settingsPatch,
  toField,
} from '../../lib/space-view.ts';
import { toast } from '../../notices/notify.ts';
import { useSpaceActions } from '../../space-queries.ts';
import { font, useTheme } from '../../theme.ts';
import {
  confirmAction,
  ErrorLine,
  Hint,
  type SectionProps,
  SwitchRow,
  useErrorToast,
} from './shared.tsx';

/**
 * Space settings: the name, the limits (each only lowering the platform's), whether members
 * invite guests and the room features; then delete (owner) or leave (anyone else), as the web.
 */
export function SettingsSection({
  origin,
  space,
  selfId,
  onLeft,
}: SectionProps & {
  /** The space is gone for this person (deleted, or left): back to the list of spaces. */
  onLeft: () => void;
}) {
  const { t } = useTranslation();
  const abilities = spaceAbilities(space);
  return (
    <>
      <SettingsForm
        key={JSON.stringify(space.settings) + space.name}
        origin={origin}
        space={space}
        selfId={selfId}
      />
      {abilities.deleteSpace ? (
        <DeleteCard origin={origin} space={space} onLeft={onLeft} />
      ) : space.role !== null ? (
        <LeaveCard origin={origin} space={space} selfId={selfId} onLeft={onLeft} />
      ) : null}
      {!abilities.updateSettings ? <Hint>{t('space.settings.readOnly')}</Hint> : null}
    </>
  );
}

function SettingsForm({ origin, space }: SectionProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const editable = spaceAbilities(space).updateSettings;
  const { updateSpace } = useSpaceActions(origin, space.id);
  const [name, setName] = useState(space.name);
  const [limits, setLimits] = useState<Record<LimitKey, string>>({
    maxStreams: toField(space.settings.maxStreams),
    maxViewersPerStream: toField(space.settings.maxViewersPerStream),
    maxBitrateKbps: toField(space.settings.maxBitrateKbps),
    quickRoomHours: toField(space.settings.quickRoomHours),
  });
  const [membersInvite, setMembersInvite] = useState(
    space.settings.membersCanInviteGuests !== false,
  );
  // What the space's rooms may have, within what the platform allows.
  const allowedNow = ceilingOf(space.effectiveSettings);
  const platform = space.platformCapabilities ?? ALL_CAPABILITIES;
  const [allowed, setAllowed] = useState<RoomCapabilities>(allowedNow);
  const allowedValid = isValidCapabilities(allowed) && aboveCeiling(allowed, platform).length === 0;
  const invalid = invalidLimits(limits);
  const current = currentLimits(space);

  const submit = () => {
    const capabilities = sameCapabilities(allowed, allowedNow) ? null : allowed;
    updateSpace.mutate(
      {
        ...(name.trim() !== space.name ? { name: name.trim() } : {}),
        settings: settingsPatch(limits, membersInvite, capabilities),
      },
      { onSuccess: () => toast(t('space.settings.saved')) },
    );
  };

  return (
    <Card>
      <Heading>{t('space.settings.title')}</Heading>
      <Hint>{t('space.settings.description')}</Hint>
      <Field
        label={t('space.settings.name')}
        value={name}
        onChangeText={setName}
        maxLength={80}
        editable={editable}
      />
      {LIMITS.map((key) => (
        <View key={key} style={styles.limit}>
          <Field
            label={t(`space.settings.limits.${key}`)}
            value={limits[key]}
            onChangeText={(v) => setLimits({ ...limits, [key]: v })}
            placeholder={String(current[key])}
            keyboardType="number-pad"
            editable={editable}
            invalid={invalid.includes(key)}
          />
          <Hint>{t('space.settings.limits.current', { value: current[key] })}</Hint>
        </View>
      ))}
      <SwitchRow
        label={t('space.settings.membersCanInviteGuests')}
        hint={t('space.settings.membersCanInviteGuestsHint')}
      >
        <Toggle
          label={t('space.settings.membersCanInviteGuests')}
          value={membersInvite}
          onValueChange={editable ? setMembersInvite : () => undefined}
        />
      </SwitchRow>
      <Text style={[styles.legend, { color: colors.foreground }]}>
        {t('space.settings.capabilities.title')}
      </Text>
      <Hint>{t('space.settings.capabilities.description')}</Hint>
      {CAPABILITIES.map((key) => {
        const blocked = !platform[key];
        return (
          <SwitchRow
            key={key}
            label={t(`capabilities.${key}.label`)}
            hint={
              blocked ? t('capabilities.notAllowedPlatform') : t(`capabilities.${key}.description`)
            }
          >
            <Toggle
              label={t(`capabilities.${key}.label`)}
              value={allowed[key]}
              onValueChange={(on) => {
                if (editable && !blocked) setAllowed(toggle(allowed, key, on));
              }}
            />
          </SwitchRow>
        );
      })}
      {!isValidCapabilities(allowed) ? <Hint>{t('capabilities.atLeastOne')}</Hint> : null}
      {editable ? (
        <>
          <Hint>{t('space.settings.limits.hint')}</Hint>
          <ErrorLine error={updateSpace.error} />
          <Button
            label={t('common.save')}
            disabled={!name.trim() || invalid.length > 0 || !allowedValid}
            busy={updateSpace.isPending}
            onPress={submit}
          />
        </>
      ) : null}
    </Card>
  );
}

function DeleteCard({
  origin,
  space,
  onLeft,
}: {
  origin: string;
  space: SectionProps['space'];
  onLeft: () => void;
}) {
  const { t } = useTranslation();
  const { deleteSpace } = useSpaceActions(origin, space.id);
  const onError = useErrorToast();
  return (
    <Card>
      <Heading>{t('space.settings.delete.title')}</Heading>
      <Hint>{t('space.settings.delete.description')}</Hint>
      <Button
        label={t('space.settings.delete.action')}
        variant="destructive"
        busy={deleteSpace.isPending}
        onPress={() =>
          confirmAction(t, {
            title: t('space.settings.delete.confirmTitle', { name: space.name }),
            message: t('space.settings.delete.confirm'),
            action: t('space.settings.delete.action'),
            onConfirm: () => deleteSpace.mutate(undefined, { onSuccess: onLeft, onError }),
          })
        }
      />
    </Card>
  );
}

function LeaveCard({
  origin,
  space,
  selfId,
  onLeft,
}: {
  origin: string;
  space: SectionProps['space'];
  selfId: string;
  onLeft: () => void;
}) {
  const { t } = useTranslation();
  const { leaveSpace } = useSpaceActions(origin, space.id);
  const onError = useErrorToast();
  return (
    <Card>
      <Heading>{t('space.settings.leave.title')}</Heading>
      <Hint>{t('space.settings.leave.description')}</Hint>
      <Button
        label={t('space.settings.leave.action')}
        variant="outline"
        busy={leaveSpace.isPending}
        onPress={() =>
          confirmAction(t, {
            title: t('space.settings.leave.confirmTitle', { name: space.name }),
            message: t('space.settings.leave.confirm'),
            action: t('space.settings.leave.action'),
            onConfirm: () => leaveSpace.mutate(selfId, { onSuccess: onLeft, onError }),
          })
        }
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  limit: { gap: 4 },
  legend: { fontFamily: font.semibold, fontSize: 15 },
});
