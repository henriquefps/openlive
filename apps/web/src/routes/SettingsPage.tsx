// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DevicesCard } from '../components/DevicesCard.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { MobileAppCard } from '../components/MobileAppCard.tsx';
import { Page } from '../components/Page.tsx';
import { ProfileCard } from '../components/ProfileCard.tsx';
import { SessionsCard } from '../components/SessionsCard.tsx';
import { PaletteSwatch, THEME_ICONS } from '../components/ThemeMenu.tsx';
import { meQuery } from '../api/auth.ts';
import {
  isPalette,
  isTheme,
  PALETTES,
  setPalette,
  setTheme,
  THEMES,
  usePalette,
  useTheme,
} from '../theme/theme.ts';
import { replayTutorials, tutorialQuery } from '../tutorial/state.ts';
import { NotificationSettingsCard } from '../notices/NotificationSettingsCard.tsx';
import { PointerSettingsCard } from '../pointer/PointerSettingsCard.tsx';
import { VoiceSettingsCard } from '../voice/VoiceSettingsCard.tsx';

export function SettingsPage() {
  const { t } = useTranslation();
  const languageId = useId();
  const theme = useTheme();
  const palette = usePalette();
  return (
    <Page title={t('settings.title')} description={t('settings.intro')}>
      <div className="flex max-w-2xl flex-col gap-4">
        <ProfileCard />
        <Card>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={languageId}>{t('language.label')}</FieldLabel>
                <FieldDescription>{t('settings.language.description')}</FieldDescription>
                <div>
                  <LanguageSelect id={languageId} />
                </div>
              </Field>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend variant="label">{t('theme.label')}</FieldLegend>
                <FieldDescription>{t('settings.theme.description')}</FieldDescription>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={theme}
                  onValueChange={(value) => {
                    if (isTheme(value)) setTheme(value);
                  }}
                  aria-label={t('theme.label')}
                >
                  {THEMES.map((option) => {
                    const Icon = THEME_ICONS[option];
                    return (
                      <ToggleGroupItem key={option} value={option}>
                        <Icon />
                        {t(`theme.${option}`)}
                      </ToggleGroupItem>
                    );
                  })}
                </ToggleGroup>
              </FieldSet>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend variant="label">{t('palette.label')}</FieldLegend>
                <FieldDescription>{t('settings.palette.description')}</FieldDescription>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  className="flex-wrap"
                  value={palette}
                  onValueChange={(value) => {
                    if (isPalette(value)) setPalette(value);
                  }}
                  aria-label={t('palette.label')}
                >
                  {PALETTES.map((option) => (
                    <ToggleGroupItem key={option} value={option}>
                      <PaletteSwatch palette={option} />
                      {t(`palette.${option}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </FieldSet>
            </FieldGroup>
          </CardContent>
        </Card>
        <VoiceSettingsCard />
        <NotificationSettingsCard />
        <PointerSettingsCard />
        <SessionsCard />
        <DevicesCard />
        <MobileAppCard />
        <TutorialCard />
      </div>
    </Page>
  );
}

/** Settings → Replay tutorial: every screen's tutorial runs again (also after "Don't show again"). */
function TutorialCard() {
  const { t } = useTranslation();
  const me = useQuery(meQuery);
  const userId = me.data?.user.id ?? null;
  const progress = useQuery({ ...tutorialQuery(userId ?? ''), enabled: userId !== null });
  const replay = useMutation({
    mutationFn: () => replayTutorials(userId ?? ''),
    onSuccess: () => toast.success(t('settings.tutorial.replayed')),
    onError: () => toast.error(t('settings.tutorial.failed')),
  });
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('settings.tutorial.title')}</CardTitle>
        <CardDescription>
          {progress.data?.disabled
            ? t('settings.tutorial.off')
            : t('settings.tutorial.description')}
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            disabled={userId === null || replay.isPending}
            onClick={() => replay.mutate()}
          >
            {t('settings.tutorial.replay')}
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  );
}
