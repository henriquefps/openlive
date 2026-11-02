// SPDX-License-Identifier: AGPL-3.0-only
import { TranslateIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { meQuery, updateMe } from '../api/auth.ts';
import { changeLanguage } from '../i18n/index.ts';
import { isLanguage, SUPPORTED_LANGUAGES } from '../i18n/language.ts';

/**
 * Language picker. Pass `id` when a visible label points at it (`htmlFor`); without one the
 * trigger names itself with `aria-label`. Signed in, the choice is saved to the profile too.
 * `compact` (top bar) shows only the icon below 640 px, so the bar fits a phone.
 */
export function LanguageSelect({ id, compact = false }: { id?: string; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const signedIn = Boolean(useQuery(meQuery).data);
  return (
    <Select
      value={i18n.resolvedLanguage ?? ''}
      onValueChange={(value) => {
        if (!isLanguage(value)) return;
        void changeLanguage(value);
        // Best effort: the local choice already applies if the profile cannot be saved.
        if (signedIn) updateMe({ locale: value }).catch(() => undefined);
      }}
    >
      <SelectTrigger
        {...(id ? { id } : { 'aria-label': t('language.label') })}
        className={compact ? 'max-sm:[&_[data-slot=select-value]]:hidden' : undefined}
      >
        <TranslateIcon />
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        <SelectGroup>
          {SUPPORTED_LANGUAGES.map((language) => (
            <SelectItem key={language} value={language} lang={language}>
              {t(`language.${language}`)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
