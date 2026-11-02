// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { canPickSink } from './audio.ts';
import type { DeviceOption } from './client.ts';
import { DUCK_AMOUNTS_DB, streamDucking } from './ducking.ts';
import { keyLabel, loadPrefs, savePrefs, type VoicePrefs } from './prefs.ts';

// Settings → Voice: the microphone, the speakers and
// push-to-talk, and lowering the stream while someone speaks (ducking.ts), for this browser. The room's voice bar reads the same prefs when it opens; its
// quick menu changes them too.

/** The system default device in the selects (Radix needs a non-empty value). */
const DEFAULT_DEVICE = 'default';

async function listDevices(): Promise<{ inputs: DeviceOption[]; outputs: DeviceOption[] }> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    return { inputs: [], outputs: [] };
  }
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const real = all.filter((d) => d.deviceId !== '' && d.deviceId !== DEFAULT_DEVICE);
  const option = (d: MediaDeviceInfo, i: number) => ({
    deviceId: d.deviceId,
    label: d.label || `${i + 1}`,
  });
  return {
    inputs: real.filter((d) => d.kind === 'audioinput').map(option),
    outputs: real.filter((d) => d.kind === 'audiooutput').map(option),
  };
}

export function VoiceSettingsCard() {
  const { t } = useTranslation();
  const inputId = useId();
  const outputId = useId();
  const pttId = useId();
  const duckId = useId();
  const duckAmountId = useId();
  const ducking = useSyncExternalStore(streamDucking.subscribe, streamDucking.getPrefs);
  const [prefs, setPrefs] = useState<VoicePrefs>(() => loadPrefs());
  const [devices, setDevices] = useState<{ inputs: DeviceOption[]; outputs: DeviceOption[] }>({
    inputs: [],
    outputs: [],
  });
  const [capturing, setCapturing] = useState(false);
  // Saving is idempotent, so running twice (StrictMode) is harmless.
  const update = useCallback(
    (patch: Partial<VoicePrefs>) =>
      setPrefs((previous) => {
        const next = { ...previous, ...patch };
        savePrefs(next);
        return next;
      }),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void listDevices().then((list) => {
        if (!cancelled) setDevices(list);
      });
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    };
  }, []);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.code !== 'Escape') update({ pushToTalkKey: event.code });
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { once: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [capturing, update]);
  const device = (id: string) => (id === DEFAULT_DEVICE ? '' : id);
  return (
    <Card size="sm" data-testid="voice-settings">
      <CardHeader>
        <CardTitle>{t('voice.settings.title')}</CardTitle>
        <CardDescription>{t('voice.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={inputId}>{t('voice.input')}</FieldLabel>
            <Select
              value={prefs.inputId || DEFAULT_DEVICE}
              onValueChange={(id) => update({ inputId: device(id) })}
            >
              <SelectTrigger id={inputId} className="w-full max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value={DEFAULT_DEVICE}>{t('voice.systemDefault')}</SelectItem>
                  {devices.inputs.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>{t('voice.settings.hint')}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={outputId}>{t('voice.output')}</FieldLabel>
            {canPickSink() ? (
              <Select
                value={prefs.outputId || DEFAULT_DEVICE}
                onValueChange={(id) => update({ outputId: device(id) })}
              >
                <SelectTrigger id={outputId} className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectGroup>
                    <SelectItem value={DEFAULT_DEVICE}>{t('voice.systemDefault')}</SelectItem>
                    {devices.outputs.map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <FieldDescription>{t('voice.outputUnsupported')}</FieldDescription>
            )}
          </Field>
          <Field orientation="horizontal">
            <Switch
              id={pttId}
              checked={prefs.pushToTalk}
              onCheckedChange={(on) => update({ pushToTalk: on })}
            />
            <FieldLabel htmlFor={pttId}>{t('voice.pushToTalk')}</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <span className="text-sm">
              {t('voice.settings.key')}:{' '}
              <kbd className="font-mono">{keyLabel(prefs.pushToTalkKey)}</kbd>
            </span>
            <Button variant="outline" size="sm" onClick={() => setCapturing(true)}>
              {t('voice.settings.changeKey')}
            </Button>
            {capturing && (
              <span className="text-[0.8125rem] text-muted-foreground" role="status">
                {t('voice.pressAKey')}
              </span>
            )}
          </Field>
          <Field orientation="horizontal">
            <Switch
              id={duckId}
              checked={ducking.enabled}
              onCheckedChange={(enabled) => streamDucking.setPrefs({ enabled })}
            />
            <FieldContent>
              <FieldLabel htmlFor={duckId}>{t('voice.ducking.label')}</FieldLabel>
              <FieldDescription>{t('voice.ducking.hint')}</FieldDescription>
            </FieldContent>
          </Field>
          <Field>
            <FieldLabel htmlFor={duckAmountId}>{t('voice.ducking.amount')}</FieldLabel>
            <Select
              value={String(ducking.amountDb)}
              disabled={!ducking.enabled}
              onValueChange={(value) => streamDucking.setPrefs({ amountDb: Number(value) })}
            >
              <SelectTrigger id={duckAmountId} className="w-full max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  {DUCK_AMOUNTS_DB.map((db) => (
                    <SelectItem key={db} value={String(db)}>
                      {t(`voice.ducking.amounts.${db}`)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
