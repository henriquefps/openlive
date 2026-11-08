// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperAudioApp, HelperStatusPayload } from '@openlive/protocol';
import { WarningIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useActiveVoice } from './use-voice-session.ts';
import { currentBrowser, echoRisk } from './voice-sink.ts';

// "People in voice will hear themselves in your stream": the stream captures the audio
// of the browser this tab plays voice in, and the voice does not go to the helper's voice sink.

type Captured = Pick<HelperAudioApp, 'name' | 'binary' | 'browser'> | null | undefined;

/** The apps the user's live helpers capture the audio of. */
export function capturedApps(statuses: Record<string, HelperStatusPayload>): HelperAudioApp[] {
  return Object.values(statuses).flatMap((s) =>
    (s.state === 'live' || s.state === 'paused' || s.state === 'starting') && s.stream?.audioApp
      ? [s.stream.audioApp]
      : [],
  );
}

export function VoiceEchoWarning({
  captured,
  compact = false,
}: {
  captured: Captured | readonly HelperAudioApp[];
  /** One line, for the phone's voice bar. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const own = currentBrowser();
  const list: Captured[] = Array.isArray(captured) ? captured : [captured as Captured];
  const active = useActiveVoice();
  const risk = list.some((app) =>
    echoRisk({
      inVoice: active?.voice.phase === 'joined',
      routed: active?.voice.voiceSinkId != null,
      captured: app,
      own,
    }),
  );
  if (!risk) return null;
  if (compact) {
    return (
      <span
        role="alert"
        className="flex items-center text-destructive"
        title={`${t('voice.echo.title')}. ${t('voice.echo.body')}`}
        data-testid="voice-echo-warning"
      >
        <WarningIcon aria-hidden />
        <span className="sr-only">
          {t('voice.echo.title')}. {t('voice.echo.body')}
        </span>
      </span>
    );
  }
  return (
    <Alert variant="destructive" data-testid="voice-echo-warning">
      <WarningIcon />
      <AlertTitle>{t('voice.echo.title')}</AlertTitle>
      <AlertDescription>{t('voice.echo.body')}</AlertDescription>
    </Alert>
  );
}

/**
 * The same warning for a browser stream: a shared screen with sound carries the whole
 * system's audio, the voice this tab plays included, unless the voice goes to the helper's sink.
 */
export function BrowserEchoWarning({ systemAudio }: { systemAudio: boolean }) {
  const { t } = useTranslation();
  const active = useActiveVoice();
  const risk = systemAudio && active?.voice.phase === 'joined' && active.voice.voiceSinkId == null;
  if (!risk) return null;
  return (
    <Alert variant="destructive" data-testid="voice-echo-warning">
      <WarningIcon />
      <AlertTitle>{t('voice.echo.title')}</AlertTitle>
      <AlertDescription>{t('voice.echo.body')}</AlertDescription>
    </Alert>
  );
}
