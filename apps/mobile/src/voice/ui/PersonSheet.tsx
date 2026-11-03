// SPDX-License-Identifier: AGPL-3.0-only
import {
  DEFAULT_PERSON_VOLUME,
  MAX_PERSON_VOLUME,
  type PersonMenuAbilities,
  type VoiceClient,
  type VoiceModeration,
  type VoiceParticipant,
} from '@openlive/client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { Body, Button } from '../../components/ui.tsx';
import { font, useTheme } from '../../theme.ts';
import { Sheet } from './Sheet.tsx';
import { VolumeSlider } from './VolumeSlider.tsx';

/**
 * Someone's menu (the web's PersonMenu): their volume, 0 to 200 % and remembered, and for owners
 * and admins (`abilities`, from personMenuAbilities) mute for everyone, remove from voice and turn
 * their camera off. Nothing for yourself.
 */
export function PersonSheet({
  participant,
  name,
  client,
  volume,
  abilities,
  moderation,
  onClose,
}: {
  participant: VoiceParticipant;
  name: string;
  client: VoiceClient | null;
  volume: number;
  abilities: PersonMenuAbilities;
  moderation: VoiceModeration;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [confirmKick, setConfirmKick] = useState(false);
  const { userId } = participant;
  const percent = Math.round(volume * 100);
  const done = (action: () => void) => () => {
    action();
    onClose();
  };
  return (
    <Sheet title={t('voice.personMenu', { name })} onClose={onClose}>
      <View style={styles.volumeHead}>
        <Text style={[styles.label, { color: colors.foreground }]}>
          {t('voice.volume', { name })}
        </Text>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>
          {t('voice.percent', { value: percent })}
        </Text>
      </View>
      <VolumeSlider
        value={percent}
        max={MAX_PERSON_VOLUME * 100}
        step={5}
        label={t('voice.volume', { name })}
        onChange={(value) => client?.setVolume(userId, value / 100)}
      />
      {volume !== DEFAULT_PERSON_VOLUME ? (
        <Button
          label={t('mobile.voice.reset')}
          variant="outline"
          onPress={() => client?.setVolume(userId, DEFAULT_PERSON_VOLUME)}
        />
      ) : null}
      {volume > 1 ? <Body muted>{t('voice.boostWarning')}</Body> : null}
      {abilities.serverMute ? (
        <Button
          label={participant.serverMuted ? t('voice.serverUnmute') : t('voice.serverMute')}
          variant="outline"
          onPress={done(() => moderation.serverMute(userId, !participant.serverMuted))}
        />
      ) : null}
      {abilities.cameraOff ? (
        <Button
          label={t('voice.cameraOff')}
          variant="outline"
          onPress={done(() => moderation.cameraOff(userId))}
        />
      ) : null}
      {abilities.kick ? (
        confirmKick ? (
          <>
            <Body tone="destructive">{t('mobile.voice.kickConfirm', { name })}</Body>
            <Button
              label={t('voice.kick')}
              variant="destructive"
              onPress={done(() => moderation.kick(userId))}
            />
            <Button
              label={t('mobile.voice.cancel')}
              variant="outline"
              onPress={() => setConfirmKick(false)}
            />
          </>
        ) : (
          <Button
            label={t('voice.kick')}
            variant="destructive"
            onPress={() => setConfirmKick(true)}
          />
        )
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  volumeHead: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { fontFamily: font.medium, fontSize: 15 },
});
