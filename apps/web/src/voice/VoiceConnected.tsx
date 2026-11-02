// SPDX-License-Identifier: AGPL-3.0-only
import {
  CameraIcon,
  CameraSlashIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';
import { meQuery } from '../api/auth.ts';
import { useHub } from '../hub/use-hub.ts';
import { type ActiveVoice, useActiveVoice, useVoiceSessions } from './use-voice-session.ts';
import { capturedApps, VoiceEchoWarning } from './VoiceEchoWarning.tsx';

// "Voice connected · <room>": the room this tab is in voice in,
// wherever the user is in the app, with mute, deafen, the camera and disconnect, and the room's
// name as the way back. At the bottom of the sidebar on wider screens; a compact bar at the
// bottom of the screen on phones. It is the only place with voice controls, on the room's own
// page too (the room has no control bar of its own while in voice).

export function VoiceConnected({
  variant,
  onNavigate,
}: {
  variant: 'sidebar' | 'bar';
  /** After the room link was followed (closes the sidebar sheet). */
  onNavigate?: () => void;
}) {
  const active = useActiveVoice();
  if (!active) return null;
  return <Panel active={active} variant={variant} onNavigate={onNavigate} />;
}

function Panel({
  active,
  variant,
  onNavigate,
}: {
  active: ActiveVoice;
  variant: 'sidebar' | 'bar';
  onNavigate: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const sessions = useVoiceSessions();
  const { session, voice, camera, room } = active;
  const { voice: client, camera: cameraClient } = session.parts;
  const name = session.name;
  const joined = voice.phase === 'joined';
  const selfId = room.voice.selfId ?? '';
  const speaking = joined && voice.transmitting && Boolean(voice.speaking[selfId]);
  const canMute = voice.micError === null && !voice.serverMuted && voice.error === null;
  const status = !joined
    ? t('voice.session.connecting')
    : room.status === 'reconnecting'
      ? t('room.connection.reconnecting')
      : t('voice.session.connected');
  const link = session.link ?? {
    to: '/rooms/$roomId' as const,
    params: { roomId: session.roomId },
  };
  const cameraOn = camera !== null && camera.phase !== 'off';
  const cameraAllowed = room.you?.permissions.canUseCamera === true;
  const cameraText = !cameraAllowed
    ? t('voice.camera.notAllowed')
    : cameraOn
      ? t('voice.camera.turnOff')
      : t('voice.camera.turnOn');
  const size = variant === 'bar' ? 'icon-sm' : 'icon';
  return (
    <section
      className={cn(
        'flex min-w-0',
        variant === 'sidebar'
          ? 'flex-col gap-2 rounded-lg border bg-card p-2 shadow-xs'
          : 'items-center gap-2 border-b px-3 py-1.5',
      )}
      aria-label={t('voice.session.label', { room: name })}
      data-testid={`voice-connected-${variant}`}
      data-phase={voice.phase}
      data-speaking={speaking ? 'true' : undefined}
      data-tour="voice-connected"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'size-2.5 shrink-0 rounded-full transition-shadow motion-reduce:transition-none',
            joined ? 'bg-primary' : 'bg-muted-foreground/40',
            speaking && 'ring-3 ring-primary/40',
          )}
          data-testid="voice-connected-dot"
        />
        <div className={cn('flex min-w-0 flex-col leading-tight', variant === 'bar' && 'flex-row')}>
          <span
            className={cn(
              'truncate text-[0.8125rem] font-medium',
              joined ? 'text-primary' : 'text-muted-foreground',
            )}
            role="status"
          >
            {status}
            {variant === 'bar' && <span aria-hidden>&nbsp;·&nbsp;</span>}
          </span>
          <Link
            {...link}
            onClick={onNavigate}
            className="truncate text-[0.8125rem] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label={t('voice.session.goTo', { room: name })}
            data-testid="voice-connected-room"
          >
            {name}
          </Link>
        </div>
      </div>
      {variant === 'sidebar' && <EchoWarning />}
      <div
        className={cn('flex shrink-0 items-center gap-1', variant === 'sidebar' && 'gap-1.5')}
        role="toolbar"
        aria-label={t('voice.controls')}
      >
        <Toggle
          variant="outline"
          size={variant === 'bar' ? 'sm' : 'default'}
          pressed={voice.muted || !canMute}
          disabled={!joined || !canMute}
          onPressedChange={(muted) => client.setMuted(muted)}
          aria-label={voice.muted ? t('voice.unmute') : t('voice.mute')}
          title={voice.muted ? t('voice.unmute') : t('voice.mute')}
          data-tour="voice-mute"
        >
          {voice.muted || !canMute ? <MicrophoneSlashIcon /> : <MicrophoneIcon />}
        </Toggle>
        <Toggle
          variant="outline"
          size={variant === 'bar' ? 'sm' : 'default'}
          pressed={voice.deafened}
          disabled={!joined}
          onPressedChange={(deafened) => client.setDeafened(deafened)}
          aria-label={voice.deafened ? t('voice.undeafen') : t('voice.deafen')}
          title={voice.deafened ? t('voice.undeafen') : t('voice.deafen')}
          data-tour="voice-deafen"
        >
          {voice.deafened ? <SpeakerSlashIcon /> : <SpeakerHighIcon />}
        </Toggle>
        {variant === 'bar' && <EchoWarning compact />}
        {camera && (
          <Toggle
            variant="outline"
            size={variant === 'bar' ? 'sm' : 'default'}
            pressed={cameraOn}
            disabled={!joined || !cameraAllowed || camera.phase === 'starting'}
            onPressedChange={() => void cameraClient.toggle()}
            aria-label={cameraText}
            title={cameraText}
            data-testid="camera-toggle"
            data-tour="voice-camera"
          >
            {cameraOn ? <CameraIcon /> : <CameraSlashIcon />}
          </Toggle>
        )}
        <Button
          variant="destructive"
          size={size}
          onClick={() => sessions.leave()}
          aria-label={t('voice.session.disconnect')}
          title={t('voice.session.disconnect')}
          className={variant === 'sidebar' ? 'ml-auto' : undefined}
        >
          <PhoneDisconnectIcon />
        </Button>
      </div>
    </section>
  );
}

/** Your helpers stream this browser's audio with the voice in it (signed in: the hub is yours). */
function EchoWarning({ compact = false }: { compact?: boolean }) {
  const me = useQuery(meQuery);
  if (!me.data) return null;
  return <HubEchoWarning compact={compact} />;
}

function HubEchoWarning({ compact }: { compact: boolean }) {
  const { state } = useHub();
  return <VoiceEchoWarning captured={capturedApps(state.statuses)} compact={compact} />;
}
