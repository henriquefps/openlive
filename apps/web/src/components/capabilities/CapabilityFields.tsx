// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomCapabilities } from '@openlive/protocol';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  aboveCeiling,
  ALL_CAPABILITIES,
  CAPABILITIES,
  isValidCapabilities,
  type Template,
  TEMPLATE_IDS,
  TEMPLATES,
  toggle,
} from '../../lib/capabilities.ts';

/**
 * One switch per capability. Camera sits under voice and follows
 * it. For a room, `ceiling` is what its space allows; for a space or the platform (`allowList`),
 * the switches say what the level below may have.
 */
export function CapabilityFields({
  value,
  onChange,
  ceiling = ALL_CAPABILITIES,
  disabled = false,
  allowList = false,
}: {
  value: RoomCapabilities;
  onChange: (next: RoomCapabilities) => void;
  ceiling?: RoomCapabilities;
  disabled?: boolean;
  allowList?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <FieldGroup className="gap-4" data-testid="capability-fields">
      {CAPABILITIES.map((key) => {
        const blocked = !ceiling[key] && !value[key];
        const off = disabled || blocked || (key === 'camera' && !value.voice);
        return (
          <Field
            key={key}
            orientation="horizontal"
            data-disabled={off ? true : undefined}
            className={cn(key === 'camera' && 'pl-6')}
          >
            <FieldContent>
              <FieldLabel htmlFor={`${id}-${key}`}>{t(`capabilities.${key}.label`)}</FieldLabel>
              <FieldDescription>
                {blocked
                  ? t(allowList ? 'capabilities.notAllowedPlatform' : 'capabilities.notAllowed')
                  : t(`capabilities.${key}.description`)}
              </FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-${key}`}
              checked={value[key]}
              onCheckedChange={(on) => onChange(toggle(value, key, on))}
              disabled={off}
            />
          </Field>
        );
      })}
      {!isValidCapabilities(value) && <FieldError>{t('capabilities.atLeastOne')}</FieldError>}
    </FieldGroup>
  );
}

/**
 * The "Create room" templates: a template the space does not
 * allow is disabled; Custom opens the switches.
 */
export function TemplatePicker({
  template,
  value,
  onChange,
  ceiling = ALL_CAPABILITIES,
}: {
  template: Template;
  value: RoomCapabilities;
  onChange: (template: Template, capabilities: RoomCapabilities) => void;
  ceiling?: RoomCapabilities;
}) {
  const { t } = useTranslation();
  const id = useId();
  const custom = (next: RoomCapabilities) => onChange('custom', next);
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup
        value={template}
        onValueChange={(next) => {
          const chosen = TEMPLATE_IDS.find((x) => x === next);
          if (!chosen) return;
          onChange(chosen, chosen === 'custom' ? value : TEMPLATES[chosen]);
        }}
        aria-label={t('capabilities.templates.label')}
        className="gap-2"
      >
        {TEMPLATE_IDS.map((choice) => {
          const blocked =
            choice !== 'custom' && aboveCeiling(TEMPLATES[choice], ceiling).length > 0;
          return (
            <FieldLabel key={choice} htmlFor={`${id}-${choice}`}>
              <Field
                orientation="horizontal"
                data-disabled={blocked ? true : undefined}
                data-testid={`template-${choice}`}
              >
                <RadioGroupItem value={choice} id={`${id}-${choice}`} disabled={blocked} />
                <FieldContent>
                  <span className="text-[0.9375rem] font-semibold">
                    {t(`capabilities.templates.${choice}.label`)}
                  </span>
                  <FieldDescription>
                    {blocked
                      ? t('capabilities.notAllowed')
                      : t(`capabilities.templates.${choice}.description`)}
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>
      {template === 'custom' && (
        <CapabilityFields value={value} onChange={custom} ceiling={ceiling} />
      )}
    </div>
  );
}
