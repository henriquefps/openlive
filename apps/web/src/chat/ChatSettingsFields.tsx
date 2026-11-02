// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatRetentionDays } from '@openlive/protocol';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

// A room's chat settings: how long messages stay, within what
// the space allows, and whether guests write.

export const RETENTION_OPTIONS: readonly ChatRetentionDays[] = [0, 7, 30, 90];

export interface ChatSettings {
  retention: ChatRetentionDays;
  guestsCanWrite: boolean;
}

export function ChatSettingsFields({
  value,
  onChange,
  ceiling,
  quick,
}: {
  value: ChatSettings;
  onChange: (next: ChatSettings) => void;
  /** The space's longest retention. */
  ceiling: number;
  /** A quick room's chat ends with the room: no retention to choose. */
  quick: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <FieldGroup className="gap-4" data-testid="chat-settings">
      <Field>
        <FieldLabel htmlFor={`${id}-retention`}>{t('chat.settings.retention')}</FieldLabel>
        {quick ? (
          <FieldDescription>{t('chat.retention.quick')}</FieldDescription>
        ) : (
          <>
            <Select
              value={String(value.retention)}
              onValueChange={(v) => {
                const chosen = RETENTION_OPTIONS.find((o) => String(o) === v);
                if (chosen !== undefined) onChange({ ...value, retention: chosen });
              }}
            >
              <SelectTrigger id={`${id}-retention`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETENTION_OPTIONS.map((days) => (
                  <SelectItem key={days} value={String(days)} disabled={days > ceiling}>
                    {days === 0
                      ? t('chat.settings.noHistory')
                      : t('chat.settings.days', { count: days })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {value.retention === 0
                ? t('chat.settings.noHistoryHint')
                : t('chat.settings.retentionHint')}
            </FieldDescription>
          </>
        )}
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-guests`}>{t('chat.settings.guestsCanWrite')}</FieldLabel>
          <FieldDescription>{t('chat.settings.guestsCanWriteHint')}</FieldDescription>
        </FieldContent>
        <Switch
          id={`${id}-guests`}
          checked={value.guestsCanWrite}
          onCheckedChange={(on) => onChange({ ...value, guestsCanWrite: on })}
        />
      </Field>
    </FieldGroup>
  );
}
