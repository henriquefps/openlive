// SPDX-License-Identifier: AGPL-3.0-only
import { DesktopIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isTheme, setTheme, THEMES, useTheme } from '../theme/theme.ts';

export const THEME_ICONS = { light: SunIcon, dark: MoonIcon, system: DesktopIcon } as const;

/** Top bar menu: Light, Dark or System. The trigger shows the current choice. */
export function ThemeMenu() {
  const { t } = useTranslation();
  const theme = useTheme();
  const Current = THEME_ICONS[theme];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('theme.label')}>
          <Current />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('theme.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) setTheme(value);
          }}
        >
          {THEMES.map((option) => {
            const Icon = THEME_ICONS[option];
            return (
              <DropdownMenuRadioItem key={option} value={option}>
                <Icon />
                {t(`theme.${option}`)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
