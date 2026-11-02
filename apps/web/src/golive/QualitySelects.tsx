// SPDX-License-Identifier: AGPL-3.0-only
import type { Preset } from '@openlive/protocol';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  frameRateOf,
  frameRateOptions,
  type PresetOffer,
  presetForResolution,
  resolutionOf,
  resolutionOptions,
} from './state.ts';

/** A resolution's label: 1080p, 1440p, and the source's own size up to 4K. */
function useResolutionLabel() {
  const { t } = useTranslation();
  return (height: number) =>
    height >= 2160 ? t('golive.options.resolution4k') : t('golive.options.resolutionP', { height });
}

/**
 * The quality of a stream as two selects, resolution and frame rate, over the presets the room
 * offers: only the frame rates a resolution has a preset for are listed.
 */
export function QualitySelects({
  offers,
  preset,
  onPreset,
  disabled,
  labelled,
}: {
  offers: readonly PresetOffer[];
  preset: Preset | null;
  onPreset: (preset: Preset) => void;
  disabled?: boolean;
  /** Show visible labels (the options screen) instead of aria-labels alone (the live bar). */
  labelled?: boolean;
}) {
  const { t } = useTranslation();
  const label = useResolutionLabel();
  const resolution = preset ? resolutionOf(preset) : undefined;
  const fpsOptions = resolution === undefined ? [] : frameRateOptions(offers, resolution);

  return (
    <div className="flex flex-wrap gap-3">
      <Field
        id="golive-resolution-label"
        text={t('golive.options.resolutionLabel')}
        labelled={labelled}
      >
        <Select
          value={resolution === undefined ? '' : String(resolution)}
          disabled={disabled}
          onValueChange={(v) => {
            if (!preset) return;
            const next = presetForResolution(offers, preset, Number(v));
            if (next) onPreset(next);
          }}
        >
          <SelectTrigger
            aria-label={labelled ? undefined : t('golive.options.resolutionLabel')}
            aria-labelledby={labelled ? 'golive-resolution-label' : undefined}
            className="w-36"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              {resolutionOptions(offers).map((o) => (
                <SelectItem key={o.resolution} value={String(o.resolution)} disabled={!o.allowed}>
                  {label(o.resolution)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field id="golive-fps-label" text={t('golive.options.fpsLabel')} labelled={labelled}>
        <Select
          value={preset ? String(frameRateOf(preset)) : ''}
          disabled={disabled}
          onValueChange={(v) => {
            const next = fpsOptions.find((o) => o.fps === Number(v));
            if (next) onPreset(next.preset);
          }}
        >
          <SelectTrigger
            aria-label={labelled ? undefined : t('golive.options.fpsLabel')}
            aria-labelledby={labelled ? 'golive-fps-label' : undefined}
            className="w-36"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              {fpsOptions.map((o) => (
                <SelectItem key={o.fps} value={String(o.fps)} disabled={!o.allowed}>
                  {o.fps}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

function Field({
  id,
  text,
  labelled,
  children,
}: {
  id: string;
  text: string;
  labelled?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {labelled && (
        <span id={id} className="text-sm font-medium">
          {text}
        </span>
      )}
      {children}
    </div>
  );
}
