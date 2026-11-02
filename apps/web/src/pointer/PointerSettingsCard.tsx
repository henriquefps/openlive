// SPDX-License-Identifier: AGPL-3.0-only
import type { PointerColor, PointerShape } from '@openlive/protocol';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { PingIndicator } from './PingIndicator.tsx';
import { POINTER_COLOR_VALUES, POINTER_COLORS, POINTER_SHAPES, pointerStyle } from './style.ts';

// Settings → Pointer: the color and shape of this person's visual clicks (docs/PROTOCOL.md 7.9),
// with a live preview. For this browser.

export function PointerSettingsCard() {
  const { t } = useTranslation();
  const style = useSyncExternalStore(pointerStyle.subscribe, pointerStyle.get);
  return (
    <Card size="sm" data-testid="pointer-settings">
      <CardHeader>
        <CardTitle>{t('pointer.settings.title')}</CardTitle>
        <CardDescription>{t('pointer.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <FieldGroup className="min-w-0 flex-1">
          <FieldSet>
            <FieldLegend variant="label">{t('pointer.settings.color')}</FieldLegend>
            <ToggleGroup
              type="single"
              variant="outline"
              value={style.color}
              onValueChange={(value) => {
                if (value) pointerStyle.update({ color: value as PointerColor });
              }}
              aria-label={t('pointer.settings.color')}
              className="flex-wrap"
              spacing={1}
            >
              {POINTER_COLORS.map((color) => (
                <ToggleGroupItem
                  key={color}
                  value={color}
                  aria-label={t(`pointer.colors.${color}`)}
                  title={t(`pointer.colors.${color}`)}
                  className="size-9 p-0"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'size-5 rounded-full border border-black/20',
                      style.color === color && 'ring-2 ring-ring ring-offset-2 ring-offset-card',
                    )}
                    style={{ background: POINTER_COLOR_VALUES[color] }}
                  />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">{t('pointer.settings.shape')}</FieldLegend>
            <FieldDescription>{t('pointer.settings.shapeHint')}</FieldDescription>
            <ToggleGroup
              type="single"
              variant="outline"
              value={style.shape}
              onValueChange={(value) => {
                if (value) pointerStyle.update({ shape: value as PointerShape });
              }}
              aria-label={t('pointer.settings.shape')}
              className="flex-wrap"
            >
              {POINTER_SHAPES.map((shape) => (
                <ToggleGroupItem key={shape} value={shape}>
                  {t(`pointer.shapes.${shape}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
        </FieldGroup>
        <div
          className="dark flex h-32 w-full shrink-0 items-center justify-center rounded-xl bg-player sm:w-44"
          data-testid="pointer-preview"
          role="img"
          aria-label={t('pointer.settings.preview', {
            color: t(`pointer.colors.${style.color}`),
            shape: t(`pointer.shapes.${style.shape}`),
          })}
        >
          <PingIndicator style={style} name={t('pointer.you')} />
        </div>
      </CardContent>
    </Card>
  );
}
