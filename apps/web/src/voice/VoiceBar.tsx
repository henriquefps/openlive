// SPDX-License-Identifier: AGPL-3.0-only
import {
  CameraIcon,
  CameraRotateIcon,
  CameraSlashIcon,
  GearSixIcon,
  HeadphonesIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';
import { translateError } from '../i18n/errors.ts';
import { isIos, useTip } from '../lib/tips.ts';
import { useTutorialScreen } from '../tutorial/context.ts';
import type { CameraClient, CameraClientState } from './camera.ts';
import type { VoiceClient, VoiceClientState } from './client.ts';
import { keyLabel } from './prefs.ts';

// The voice bar: join or leave, mute, deafen, push-to-talk and
// the audio devices, with what is going on said in words: muted, deafened, push-to-talk, why there
// is no microphone, and the "use headphones" hint when joining. "Your microphone is on" and the
// iPhone note are one-time tips (lib/tips.ts): the speaking ring is the everyday signal. In a room with cameras (PROTOCOL 7.7)
// it also has the camera toggle, the camera devices and "you're on camera".

/** The camera part of the bar: only in a room with the camera capability. */
export interface CameraBarProps {
  client: CameraClient | null;
  state: CameraClientState;
  /** Permissions.canUseCamera: off for guests unless the room lets them. */
  allowed: boolean;
}

/** The system default device, in the radio groups (Radix needs a non-empty value). */
const DEFAULT_DEVICE = 'default';

export function VoiceBar({
  client,
  state,
  canJoin,
  camera = null,
  compact = false,
  docked = false,
  onJoin,
  className,
}: {
  client: VoiceClient | null;
  state: VoiceClientState;
  /** The room lets this person join (Permissions.canJoinVoice). */
  canJoin: boolean;
  /** Join instead of `client.join()` (the app's voice session asks to switch rooms first). */
  onJoin?: (() => void) | undefined;
  /** The room has cameras. */
  camera?: CameraBarProps | null;
  /** A narrow panel: icon-only controls (the labels stay for screen readers). */
  compact?: boolean;
  /**
   * Join and the controls live elsewhere (JoinVoiceButton, the "Voice connected" panel): this
   * shows what is going on (the status line, the notices), with push-to-talk and the devices.
   */
  docked?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const joined = state.phase === 'joined';
  useTutorialScreen('voice', joined);
  return (
    <div
      className={cn('flex flex-col gap-3', docked && 'empty:hidden', className)}
      data-tour={docked && !joined ? undefined : 'room-voice-bar'}
      data-testid={docked ? 'voice-status' : undefined}
    >
      {docked ? null : state.phase === 'idle' ? (
        <Button
          className="self-start"
          disabled={!client || !canJoin}
          onClick={() => (onJoin ? onJoin() : void client?.join())}
        >
          <MicrophoneIcon data-icon="inline-start" />
          {t('voice.join')}
        </Button>
      ) : state.phase === 'joining' ? (
        <Button className="self-start" disabled>
          <Spinner data-icon="inline-start" />
          {t('voice.joining')}
        </Button>
      ) : (
        client && <VoiceControls client={client} state={state} camera={camera} compact={compact} />
      )}
      {joined && docked && client ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <TransmitStatus state={state} />
          {camera && <CameraStatus camera={camera} />}
          <div className="ml-auto flex items-center gap-2">
            <PushToTalkButton client={client} state={state} />
            <DevicesMenu client={client} state={state} camera={camera} />
          </div>
        </div>
      ) : (
        <>
          {joined && <TransmitStatus state={state} />}
          {joined && camera && <CameraStatus camera={camera} />}
        </>
      )}
      <VoiceNotices client={client} state={state} />
      {camera && <CameraNotices camera={camera} />}
    </div>
  );
}

/**
 * Join voice: the room's one way in (in the empty stage, or under the tiles). Once in, the app's
 * "Voice connected" panel (VoiceConnected.tsx) has the controls, on the room's page too.
 */
export function JoinVoiceButton({
  client,
  state,
  canJoin,
  onJoin,
  className,
}: {
  client: VoiceClient | null;
  state: VoiceClientState;
  canJoin: boolean;
  /** Join instead of `client.join()` (the app's voice session asks to switch rooms first). */
  onJoin?: (() => void) | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const joining = state.phase === 'joining';
  return (
    <Button
      size="lg"
      className={className}
      disabled={joining || !client || !canJoin}
      onClick={() => (onJoin ? onJoin() : void client?.join())}
      data-tour="room-voice-bar"
      data-testid="join-voice"
    >
      {joining ? <Spinner data-icon="inline-start" /> : <MicrophoneIcon data-icon="inline-start" />}
      {joining ? t('voice.joining') : t('voice.join')}
    </Button>
  );
}

function VoiceControls({
  client,
  state,
  camera,
  compact,
}: {
  client: VoiceClient;
  state: VoiceClientState;
  camera: CameraBarProps | null;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const label = compact ? 'sr-only' : 'max-sm:sr-only';
  const canMute = state.micError === null && !state.serverMuted && state.error === null;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="toolbar"
      aria-label={t('voice.controls')}
    >
      <Toggle
        variant="outline"
        pressed={state.muted || !canMute}
        disabled={!canMute}
        onPressedChange={(muted) => client.setMuted(muted)}
        aria-label={state.muted ? t('voice.unmute') : t('voice.mute')}
        title={compact ? (state.muted ? t('voice.unmute') : t('voice.mute')) : undefined}
        data-tour="voice-mute"
      >
        {state.muted || !canMute ? <MicrophoneSlashIcon /> : <MicrophoneIcon />}
        <span className={label}>{state.muted ? t('voice.unmute') : t('voice.mute')}</span>
      </Toggle>
      <Toggle
        variant="outline"
        pressed={state.deafened}
        onPressedChange={(deafened) => client.setDeafened(deafened)}
        aria-label={state.deafened ? t('voice.undeafen') : t('voice.deafen')}
        title={compact ? (state.deafened ? t('voice.undeafen') : t('voice.deafen')) : undefined}
        data-tour="voice-deafen"
      >
        {state.deafened ? <SpeakerSlashIcon /> : <SpeakerHighIcon />}
        <span className={label}>{state.deafened ? t('voice.undeafen') : t('voice.deafen')}</span>
      </Toggle>
      <PushToTalkButton client={client} state={state} />
      {camera && <CameraToggle camera={camera} compact={compact} />}
      <DevicesMenu client={client} state={state} camera={camera} />
      <Button
        variant="outline"
        size={compact ? 'icon' : 'default'}
        onClick={() => client.leave()}
        aria-label={t('voice.leave')}
        title={compact ? t('voice.leave') : undefined}
      >
        <PhoneDisconnectIcon data-icon={compact ? undefined : 'inline-start'} />
        <span className={label}>{t('voice.leave')}</span>
      </Button>
    </div>
  );
}

/** Hold to talk (touch screens), while push-to-talk is on. */
function PushToTalkButton({ client, state }: { client: VoiceClient; state: VoiceClientState }) {
  const { t } = useTranslation();
  const canMute = state.micError === null && !state.serverMuted && state.error === null;
  if (!state.pushToTalk || !canMute) return null;
  return (
    <Button
      variant="outline"
      aria-pressed={state.pttPressed}
      className={cn(state.pttPressed && 'bg-muted')}
      onPointerDown={() => client.setPttPressed(true)}
      onPointerUp={() => client.setPttPressed(false)}
      onPointerLeave={() => client.setPttPressed(false)}
      onPointerCancel={() => client.setPttPressed(false)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') client.setPttPressed(true);
      }}
      onKeyUp={() => client.setPttPressed(false)}
    >
      {t('voice.holdToTalk', { key: keyLabel(state.pushToTalkKey) })}
    </Button>
  );
}

/** Camera on or off (off by default, a click turns it on). */
function CameraToggle({ camera, compact }: { camera: CameraBarProps; compact: boolean }) {
  const { t } = useTranslation();
  const label = compact ? 'sr-only' : 'max-sm:sr-only';
  const on = camera.state.phase !== 'off';
  const text = !camera.allowed
    ? t('voice.camera.notAllowed')
    : camera.state.phase === 'starting'
      ? t('voice.camera.starting')
      : on
        ? t('voice.camera.turnOff')
        : t('voice.camera.turnOn');
  return (
    <Toggle
      variant="outline"
      pressed={on}
      disabled={!camera.client || !camera.allowed || camera.state.phase === 'starting'}
      onPressedChange={() => void camera.client?.toggle()}
      aria-label={text}
      title={compact || !camera.allowed ? text : undefined}
      data-testid="camera-toggle"
      data-tour="voice-camera"
    >
      {camera.state.phase === 'starting' ? <Spinner /> : on ? <CameraIcon /> : <CameraSlashIcon />}
      <span className={label}>{on ? t('voice.camera.turnOff') : t('voice.camera.turnOn')}</span>
    </Toggle>
  );
}

/** "You're on camera" (privacy), and the cameras giving way to the voice. */
function CameraStatus({ camera }: { camera: CameraBarProps }) {
  const { t } = useTranslation();
  const { phase, network } = camera.state;
  return (
    <>
      {phase === 'on' && (
        <p
          className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground"
          role="status"
          data-testid="camera-on-air"
        >
          <span aria-hidden className="size-2 rounded-full bg-destructive" />
          {t('voice.camera.onAir')}
        </p>
      )}
      {network !== 'good' && (
        <p className="text-[0.8125rem] text-muted-foreground" role="status">
          {network === 'bad' ? t('voice.camera.paused') : t('voice.camera.lowQuality')}
        </p>
      )}
    </>
  );
}

/** Why the camera is off: the device, a refusal of the room, or the room turned it off. */
function CameraNotices({ camera }: { camera: CameraBarProps }) {
  const { t } = useTranslation();
  const { error, refused, stopped } = camera.state;
  const message = refused
    ? translateError(refused, t)
    : stopped
      ? t(`voice.camera.stopped.${stopped}`)
      : error
        ? t(`voice.camera.error.${error}`)
        : null;
  if (message === null) return null;
  return (
    <Alert data-testid="camera-notice">
      <CameraSlashIcon />
      <AlertTitle>{message}</AlertTitle>
      <AlertDescription>
        <Button variant="outline" size="sm" onClick={() => camera.client?.dismiss()}>
          {t('voice.camera.dismiss')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** The quick devices menu: microphone, speakers, the camera, push-to-talk and its key. */
function DevicesMenu({
  client,
  state,
  camera,
}: {
  client: VoiceClient;
  state: VoiceClientState;
  camera: CameraBarProps | null;
}) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.code !== 'Escape') client.setPushToTalk(true, event.code);
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { once: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [capturing, client]);
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          void client.refreshDevices();
          void camera?.client?.refreshDevices();
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('voice.devices')}
            data-tour="voice-devices"
          >
            <GearSixIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('voice.input')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={state.inputId || DEFAULT_DEVICE}
              onValueChange={(id) => void client.setInput(id === DEFAULT_DEVICE ? '' : id)}
            >
              <DropdownMenuRadioItem value={DEFAULT_DEVICE}>
                {t('voice.systemDefault')}
              </DropdownMenuRadioItem>
              {state.inputs.map((d) => (
                <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId}>
                  <span className="truncate">{d.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('voice.output')}</DropdownMenuLabel>
            {state.canPickOutput ? (
              <DropdownMenuRadioGroup
                value={state.outputId || DEFAULT_DEVICE}
                onValueChange={(id) => void client.setOutput(id === DEFAULT_DEVICE ? '' : id)}
              >
                <DropdownMenuRadioItem value={DEFAULT_DEVICE}>
                  {t('voice.systemDefault')}
                </DropdownMenuRadioItem>
                {state.outputs.map((d) => (
                  <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId}>
                    <span className="truncate">{d.label}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            ) : (
              <p className="px-2 py-1.5 text-[0.8125rem] text-muted-foreground">
                {t('voice.outputUnsupported')}
              </p>
            )}
          </DropdownMenuGroup>
          {camera?.client && camera.allowed && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('voice.camera.devices')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={camera.state.inputId || DEFAULT_DEVICE}
                  onValueChange={(id) =>
                    void camera.client?.setInput(id === DEFAULT_DEVICE ? '' : id)
                  }
                >
                  <DropdownMenuRadioItem value={DEFAULT_DEVICE}>
                    {camera.state.facing === 'user'
                      ? t('voice.camera.front')
                      : t('voice.camera.back')}
                  </DropdownMenuRadioItem>
                  {camera.state.inputs.map((d) => (
                    <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId}>
                      <span className="truncate">{d.label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuItem onSelect={() => void camera.client?.flip()}>
                  <CameraRotateIcon />
                  {t('voice.camera.flip')}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={state.pushToTalk}
            onCheckedChange={(on) => client.setPushToTalk(on === true)}
          >
            {t('voice.pushToTalk')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem onSelect={() => setCapturing(true)}>
            {t('voice.pushToTalkKey', { key: keyLabel(state.pushToTalkKey) })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {capturing && (
        <span className="text-[0.8125rem] text-muted-foreground" role="status">
          {t('voice.pressAKey')}
        </span>
      )}
    </>
  );
}

/**
 * Whether the microphone is sending now, in words (privacy). "Sending" is a
 * one-time tip: after it, the speaking ring says it.
 */
function TransmitStatus({ state }: { state: VoiceClientState }) {
  const { t } = useTranslation();
  const tip = useTip('voice-mic-on', state.transmitting);
  const status = state.transmitting
    ? 'sending'
    : state.serverMuted
      ? 'serverMuted'
      : state.micError !== null || state.error !== null
        ? 'listening'
        : state.deafened
          ? 'deafened'
          : state.muted
            ? 'muted'
            : state.pushToTalk
              ? 'pushToTalk'
              : 'connecting';
  if (status === 'sending' && !tip.show) return null;
  return (
    <p
      className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground"
      role="status"
      data-voice-status={status}
    >
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          state.transmitting ? 'bg-primary' : 'bg-muted-foreground/40',
        )}
      />
      {t(`voice.status.${status}`, { key: keyLabel(state.pushToTalkKey) })}
      {status === 'sending' && <DismissTip onClick={tip.dismiss} />}
    </p>
  );
}

/** "Got it" on a one-time tip. */
function DismissTip({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 align-baseline text-[0.8125rem] text-muted-foreground"
      onClick={onClick}
    >
      {t('voice.tips.dismiss')}
    </Button>
  );
}

/** Why there is no microphone, refusals, removals, the headphones hint and the iPhone tip. */
function VoiceNotices({ client, state }: { client: VoiceClient | null; state: VoiceClientState }) {
  const { t } = useTranslation();
  const [ios] = useState(() => isIos());
  const [hintDismissed, setHintDismissed] = useState(
    () => client?.prefsSnapshot.headphonesHintDismissed ?? false,
  );
  const joined = state.phase === 'joined';
  const iosTip = useTip('voice-ios-background', joined && ios);
  return (
    <>
      {state.removed && (
        <Alert>
          <PhoneDisconnectIcon />
          <AlertTitle>{t(`voice.removed.${state.removed}`)}</AlertTitle>
        </Alert>
      )}
      {state.error && (
        <Alert variant={state.phase === 'idle' ? 'destructive' : 'default'}>
          <WarningIcon />
          <AlertTitle>{translateError(state.error, t)}</AlertTitle>
          {state.phase !== 'idle' && <AlertDescription>{t('voice.listenOnly')}</AlertDescription>}
        </Alert>
      )}
      {state.phase !== 'idle' && state.micError && (
        <Alert>
          <MicrophoneSlashIcon />
          <AlertTitle>{t(`voice.micError.${state.micError}`)}</AlertTitle>
          <AlertDescription>{t('voice.listenOnly')}</AlertDescription>
        </Alert>
      )}
      {joined && !hintDismissed && state.micError === null && (
        <p className="text-[0.8125rem] text-muted-foreground" data-testid="headphones-tip">
          <HeadphonesIcon aria-hidden className="mr-1.5 inline size-3.5 align-[-2px]" />
          {t('voice.headphones.tip')}{' '}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 align-baseline text-[0.8125rem] text-muted-foreground"
            onClick={() => {
              client?.dismissHeadphonesHint();
              setHintDismissed(true);
            }}
          >
            {t('voice.headphones.dismiss')}
          </Button>
        </p>
      )}
      {iosTip.show && (
        <p className="text-[0.8125rem] text-muted-foreground" data-testid="ios-tip">
          {t('voice.tips.ios')} <DismissTip onClick={iosTip.dismiss} />
        </p>
      )}
    </>
  );
}
