// SPDX-License-Identifier: AGPL-3.0-only
import {
  CameraIcon,
  CameraSlashIcon,
  DotsThreeIcon,
  MicrophoneSlashIcon,
  SpeakerSlashIcon,
  UserMinusIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import type { Member, Role } from '@openlive/protocol';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { canActOn } from '../api/permissions.ts';
import type { VoiceModeration } from '../room/socket-api.ts';
import type { VoiceClient, VoiceClientState } from './client.ts';
import type { VoiceParticipant } from './contract.ts';
import { outputLabel, warnBoost } from './headphones.ts';
import { DEFAULT_PERSON_VOLUME, MAX_PERSON_VOLUME } from './prefs.ts';

// Who is in voice: the "In voice" list of the presence card
// and the large tiles of a voice-only room, with mute, deafen and server-mute icons and a ring
// while someone speaks. Each person has a menu with their volume (0–200 %, remembered) and, for
// owners and admins, server mute and "remove from voice". Above 100 % without headphones, the
// menu says echo cancellation may not cover the boost (headphones.ts).

export interface VoicePeopleProps {
  participants: readonly VoiceParticipant[];
  members: readonly Member[];
  selfId: string;
  client: VoiceClient | null;
  state: VoiceClientState;
  /** Owner or admin of the room (Permissions.canModerate) and their role. */
  moderator: { role: Role | null } | null;
  moderation: VoiceModeration;
}

export function useWho(members: readonly Member[]) {
  const { t } = useTranslation();
  return (userId: string) => {
    const member = members.find((m) => m.userId === userId);
    return {
      name: member?.displayName ?? t('player.someone'),
      avatarUrl: member?.avatarUrl,
      role: member?.role ?? ('guest' as Role),
    };
  };
}

/** Mute, deafen and server-mute icons, each with a label for screen readers. */
export function StateIcons({ participant }: { participant: VoiceParticipant }) {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {participant.serverMuted ? (
        <MicrophoneSlashIcon
          className="text-destructive"
          aria-label={t('voice.state.serverMuted')}
          role="img"
        />
      ) : (
        participant.muted &&
        !participant.deafened && (
          <MicrophoneSlashIcon aria-label={t('voice.state.muted')} role="img" />
        )
      )}
      {participant.deafened && (
        <SpeakerSlashIcon aria-label={t('voice.state.deafened')} role="img" />
      )}
      {participant.camera && <CameraIcon aria-label={t('voice.state.camera')} role="img" />}
    </span>
  );
}

export function VoiceAvatar({
  name,
  avatarUrl,
  speaking,
  large,
}: {
  name: string;
  avatarUrl?: string | undefined;
  speaking: boolean;
  large?: boolean;
}) {
  return (
    <Avatar
      size={large ? 'lg' : 'default'}
      className={cn(
        'ring-offset-2 ring-offset-card transition-shadow motion-reduce:transition-none',
        large && 'size-16 data-[size=lg]:size-16',
        speaking && 'ring-2 ring-primary',
      )}
      data-speaking={speaking ? 'true' : 'false'}
    >
      {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
      <AvatarFallback className={cn(large && 'text-lg')}>
        {name.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** The "In voice" section of the presence card. */
export function VoicePresence(props: VoicePeopleProps) {
  const { t } = useTranslation();
  const who = useWho(props.members);
  const { participants } = props;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="room-in-voice" data-testid="in-voice">
      <h3 id="room-in-voice" className="eyebrow text-muted-foreground">
        {t('voice.inVoice', { count: participants.length })}
      </h3>
      {participants.length === 0 ? (
        <p className="text-[0.9375rem] text-muted-foreground">{t('voice.nobody')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {participants.map((p) => {
            const person = who(p.userId);
            const speaking = props.state.speaking[p.userId] === true;
            return (
              <li
                key={p.userId}
                className="flex items-center gap-2"
                data-voice-user={p.userId}
                data-speaking={speaking ? 'true' : 'false'}
              >
                <VoiceAvatar name={person.name} avatarUrl={person.avatarUrl} speaking={speaking} />
                <span className="min-w-0 flex-1 truncate text-[0.9375rem]">
                  {person.name}
                  {p.userId === props.selfId && (
                    <span className="text-muted-foreground"> {t('space.members.you')}</span>
                  )}
                  {speaking && <span className="sr-only"> {t('voice.state.speaking')}</span>}
                </span>
                <StateIcons participant={p} />
                <PersonMenu {...props} participant={p} name={person.name} role={person.role} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A voice-only room: everyone in voice, large. */
export function VoiceTiles(props: VoicePeopleProps) {
  const { t } = useTranslation();
  const who = useWho(props.members);
  if (props.participants.length === 0) {
    return <p className="text-[0.9375rem] text-muted-foreground">{t('voice.nobody')}</p>;
  }
  return (
    <ul
      className="grid w-full grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3"
      aria-label={t('voice.inVoice', { count: props.participants.length })}
    >
      {props.participants.map((p) => {
        const person = who(p.userId);
        const speaking = props.state.speaking[p.userId] === true;
        return (
          <li
            key={p.userId}
            className="relative flex flex-col items-center gap-2 rounded-xl border bg-card p-4"
            data-voice-tile={p.userId}
          >
            <VoiceAvatar
              name={person.name}
              avatarUrl={person.avatarUrl}
              speaking={speaking}
              large
            />
            <span className="flex w-full items-center justify-center gap-1 text-[0.9375rem]">
              <span className="truncate">{person.name}</span>
              <StateIcons participant={p} />
            </span>
            {speaking && <span className="sr-only">{t('voice.state.speaking')}</span>}
            <div className="absolute top-1 right-1">
              <PersonMenu {...props} participant={p} name={person.name} role={person.role} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Volume for someone else, and moderation for owners and admins. Nothing for yourself. */
export function PersonMenu({
  participant,
  name,
  role,
  selfId,
  client,
  state,
  moderator,
  moderation,
}: VoicePeopleProps & { participant: VoiceParticipant; name: string; role: Role }) {
  const { t } = useTranslation();
  const sliderId = useId();
  const warningId = useId();
  const { userId } = participant;
  if (userId === selfId) return null;
  const moderate = moderator !== null && canActOn(moderator.role, selfId, { userId, role });
  const volume = state.volumes[userId] ?? DEFAULT_PERSON_VOLUME;
  const percent = Math.round(volume * 100);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('voice.personMenu', { name })}>
          <DotsThreeIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel id={sliderId}>
          {t('voice.volume', { name })}
          <span className="float-right tabular-nums text-muted-foreground">
            {t('voice.percent', { value: percent })}
          </span>
        </DropdownMenuLabel>
        <div className="px-2 pt-1 pb-3">
          <Slider
            value={[percent]}
            min={0}
            max={MAX_PERSON_VOLUME * 100}
            step={5}
            disabled={!client}
            aria-labelledby={sliderId}
            aria-describedby={volume > 1 ? warningId : undefined}
            onValueChange={([value]) => client?.setVolume(userId, (value ?? 100) / 100)}
          />
        </div>
        {volume > 1 && <BoostWarning id={warningId} volume={volume} outputId={state.outputId} />}
        {moderate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => moderation.serverMute(userId, !participant.serverMuted)}
            >
              <MicrophoneSlashIcon />
              {participant.serverMuted ? t('voice.serverUnmute') : t('voice.serverMute')}
            </DropdownMenuItem>
            {participant.camera && (
              <DropdownMenuItem onSelect={() => moderation.cameraOff(userId)}>
                <CameraSlashIcon />
                {t('voice.cameraOff')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => moderation.kick(userId)}>
              <UserMinusIcon />
              {t('voice.kick')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The output's name, read when the menu opens (Chrome names the default after the device). */
function useOutputLabel(outputId: string): string | undefined {
  const [label, setLabel] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => {
        if (!cancelled) setLabel(outputLabel(devices, outputId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [outputId]);
  return label;
}

/** Boosted above 100 % on what may be speakers: echo cancellation may not cover it. */
function BoostWarning({ id, volume, outputId }: { id: string; volume: number; outputId: string }) {
  const { t } = useTranslation();
  const label = useOutputLabel(outputId);
  if (!warnBoost(volume, label)) return null;
  return (
    <p
      id={id}
      className="flex gap-1.5 px-2 pb-2 text-[0.8125rem] text-muted-foreground"
      data-testid="boost-warning"
    >
      <WarningIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {t('voice.boostWarning')}
    </p>
  );
}
