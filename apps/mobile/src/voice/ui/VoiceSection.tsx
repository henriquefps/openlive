// SPDX-License-Identifier: AGPL-3.0-only
import { personMenuAbilities, type VoiceParticipant } from '@openlive/client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Glyph, stateGlyph } from '../../components/Glyph.tsx';
import { Avatar, Body, Button, Card } from '../../components/ui.tsx';
import { font, useTheme } from '../../theme.ts';
import { stateIcons } from '../view.ts';
import { voice as nativeVoice } from '../../voice-native/index.ts';
import { voiceSessions } from '../host.ts';
import type { RoomVoice } from '../hooks.ts';
import { CallStage, useStageSize } from './CallStage.tsx';
import { ControlBar } from './Controls.tsx';
import { PersonSheet } from './PersonSheet.tsx';

/**
 * The room's voice on the room screen (the web's call stage and controls): a Join button while
 * out of voice; in voice the stage (everyone, their cameras, the speaking ring) over the controls.
 * The person menu opens from a tile.
 */
export function VoiceSection({ voice: v }: { voice: RoomVoice }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { room, voice, camera, session } = v;
  const { height: windowHeight } = useWindowDimensions();
  const [onLayout, size] = useStageSize();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const you = room.you;
  const selfId = room.voice.selfId ?? '';
  const phone = session.parts.voice;
  const online = room.status === 'open';
  const canJoin = online && you !== null && you.permissions.canJoinVoice !== false;
  const participants = room.voice.participants;
  const target = menuFor ? participants.find((p) => p.userId === menuFor) : undefined;
  const targetMember = target ? room.members.find((m) => m.userId === target.userId) : undefined;
  const joined = voice.phase !== 'idle';

  if (!v.inVoice) {
    return (
      <Card>
        <View style={styles.head}>
          <View style={styles.grow}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              {t('mobile.voice.title')}
              {participants.length > 0 ? (
                <Text style={{ color: colors.mutedForeground }}> · {participants.length}</Text>
              ) : null}
            </Text>
            {participants.length === 0 ? (
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                {t('mobile.voice.nobody')}
              </Text>
            ) : null}
          </View>
          <Button compact label={t('voice.join')} disabled={!canJoin} onPress={() => v.join()} />
        </View>
        {participants.length > 0 ? <CallFaces v={v} /> : null}
        {!nativeVoice.supported ? (
          <Body tone="warning">{t('mobile.voice.unsupported')}</Body>
        ) : null}
        {voice.joinFailure === 'service_failed' ? (
          <Body tone="destructive">{t('mobile.voice.startFailed')}</Body>
        ) : null}
        {voice.removed ? <Body tone="warning">{t(`voice.removed.${voice.removed}`)}</Body> : null}
        {voice.error ? (
          <Body tone="destructive">
            {t(`errors.${voice.error.code}`, {
              defaultValue: t('errors.generic', { code: voice.error.code }),
            })}
          </Body>
        ) : null}
      </Card>
    );
  }

  const stageHeight = Math.round(Math.min(560, Math.max(260, windowHeight * 0.48)));
  const abilities = target
    ? personMenuAbilities(
        {
          userId: selfId,
          role: you?.role ?? null,
          canModerate: you?.permissions.canModerate === true,
        },
        {
          userId: target.userId,
          role: targetMember?.role ?? 'guest',
          camera: target.camera === true,
        },
      )
    : null;
  return (
    <>
      {voice.preparing ? <Body muted>{t('mobile.voice.preparing')}</Body> : null}
      <View style={{ height: stageHeight }} onLayout={onLayout}>
        {size.width > 0 ? (
          <CallStage
            participants={participants}
            members={room.members}
            selfId={selfId}
            speaking={voice.speaking}
            cameras={v.hasCamera ? { client: session.parts.camera, state: camera } : null}
            width={size.width}
            height={size.height}
            onMenu={setMenuFor}
          />
        ) : null}
      </View>
      <ControlBar
        phone={phone}
        state={voice}
        cameraClient={v.hasCamera ? session.parts.camera : null}
        camera={v.hasCamera ? camera : null}
        canUseCamera={you?.permissions.canUseCamera === true}
        onLeave={() => voiceSessions.leave()}
      />
      {target && abilities && joined ? (
        <PersonSheet
          participant={target}
          name={targetMember?.displayName ?? t('mobile.voice.someone')}
          client={session.parts.client}
          volume={voice.volumes[target.userId] ?? 1}
          abilities={abilities}
          moderation={session.parts.moderation}
          onClose={() => setMenuFor(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Who is in voice before you join (Discord's voice channel): their photos in a row with the
 * speaking ring and the mute, deafen and camera badges, and the names on one line.
 */
function CallFaces({ v }: { v: RoomVoice }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { participants } = v.room.voice;
  const members = v.room.members;
  const people = participants.map((p) => {
    const member = members.find((m) => m.userId === p.userId);
    return { p, name: member?.displayName ?? t('mobile.voice.someone'), url: member?.avatarUrl };
  });
  return (
    <View
      accessible
      accessibilityLabel={`${t('voice.inVoice', { count: people.length })}: ${people
        .map((x) => x.name)
        .join(', ')}`}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.faces}
      >
        {people.map(({ p, name, url }) => (
          <View key={p.userId} style={styles.face}>
            <Avatar name={name} url={url} size={40} ring={v.voice.speaking[p.userId] === true} />
            <FaceBadge participant={p} />
          </View>
        ))}
      </ScrollView>
      <Text numberOfLines={1} style={[styles.meta, { color: colors.mutedForeground }]}>
        {people.map((x) => x.name).join(', ')}
      </Text>
    </View>
  );
}

/** A small round badge over the photo's corner: server-muted, muted or deafened. */
function FaceBadge({ participant }: { participant: VoiceParticipant }) {
  const { colors } = useTheme();
  const icon = stateIcons(participant).find((i) => i !== 'camera');
  if (!icon) return null;
  return (
    <View style={[styles.badge, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Glyph
        name={stateGlyph(icon)}
        size={11}
        slashed
        color={icon === 'serverMuted' ? colors.destructive : colors.foreground}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, gap: 1 },
  title: { fontFamily: font.semibold, fontSize: 16 },
  meta: { fontFamily: font.regular, fontSize: 13 },
  faces: { gap: 10, paddingVertical: 4, paddingRight: 4 },
  face: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
