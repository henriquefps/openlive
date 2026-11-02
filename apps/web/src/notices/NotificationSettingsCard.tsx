// SPDX-License-Identifier: AGPL-3.0-only
import { SpeakerHighIcon } from '@phosphor-icons/react';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { EVENT_RULES } from './policy.ts';
import { NOTICE_KINDS, type NoticeKind, noticeSettings } from './settings.ts';
import { type Sound, WebAudioSounds } from './sounds.ts';

// Settings → Notifications: each notice on or off, "mute
// all" (the toasts stay) and the volume, with a button to hear each sound. For this browser.

/** The sound a kind plays first (voice: the join), for its "play" button. */
const SOUND_OF = {} as Record<NoticeKind, Sound>;
for (const rule of Object.values(EVENT_RULES)) SOUND_OF[rule.kind] ??= rule.sound;

export function NotificationSettingsCard() {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(noticeSettings.subscribe, noticeSettings.get);
  const mutedId = useId();
  const volumeId = useId();
  const baseId = useId();
  // The click on "play" is the interaction the browser wants before a sound.
  const [sounds] = useState(() => new WebAudioSounds());
  useEffect(() => () => sounds.dispose(), [sounds]);
  const preview = (sound: Sound) => {
    sounds.unlock();
    sounds.play(sound, settings.volume);
  };
  return (
    <Card size="sm" data-testid="notification-settings">
      <CardHeader>
        <CardTitle>{t('notices.settings.title')}</CardTitle>
        <CardDescription>{t('notices.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="horizontal">
            <Switch
              id={mutedId}
              checked={settings.muted}
              onCheckedChange={(muted) => noticeSettings.update({ muted })}
            />
            <FieldContent>
              <FieldLabel htmlFor={mutedId}>{t('notices.settings.muteAll')}</FieldLabel>
              <FieldDescription>{t('notices.settings.muteAllHint')}</FieldDescription>
            </FieldContent>
          </Field>
          <Field>
            <FieldLabel id={volumeId}>
              {t('notices.settings.volume')}
              <span className="ml-auto tabular-nums text-muted-foreground">
                {t('voice.percent', { value: Math.round(settings.volume * 100) })}
              </span>
            </FieldLabel>
            <Slider
              className="max-w-sm"
              value={[Math.round(settings.volume * 100)]}
              min={0}
              max={100}
              step={5}
              disabled={settings.muted}
              aria-labelledby={volumeId}
              onValueChange={([value]) => noticeSettings.update({ volume: (value ?? 70) / 100 })}
            />
          </Field>
          <FieldSeparator />
          {NOTICE_KINDS.map((kind) => {
            const id = `${baseId}-${kind}`;
            return (
              <Field key={kind} orientation="horizontal" data-notice={kind}>
                <Switch
                  id={id}
                  checked={settings.events[kind]}
                  onCheckedChange={(on) => noticeSettings.update({ events: { [kind]: on } })}
                />
                <FieldContent>
                  <FieldLabel htmlFor={id}>{t(`notices.settings.kinds.${kind}`)}</FieldLabel>
                  <FieldDescription>{t(`notices.settings.hints.${kind}`)}</FieldDescription>
                </FieldContent>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={settings.muted}
                  onClick={() => preview(SOUND_OF[kind])}
                  aria-label={t('notices.settings.preview', {
                    name: t(`notices.settings.kinds.${kind}`),
                  })}
                  title={t('notices.settings.previewShort')}
                >
                  <SpeakerHighIcon />
                </Button>
              </Field>
            );
          })}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
