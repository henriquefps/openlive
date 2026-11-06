// SPDX-License-Identifier: AGPL-3.0-only
import { useColorScheme } from 'react-native';
import { type Colors, type Mode, paletteColors } from './lib/palette.ts';
import type { AppSettings } from './lib/settings.ts';
import { setPalette, setTheme, useSettings } from './settings.ts';

// The hfps tokens of the web app (palettes, Inter), as sRGB: React Native has no OKLCH. The mode
// (light, dark, system) is forced on the OS color scheme in settings.ts, so `useColorScheme`
// already answers with what to draw; the palette is a second, independent choice.

/** Every token of the current palette and mode (kept under the name screens already use). */
export type Palette = Colors;

/** Inter, embedded at build time by the expo-font plugin (app.json). */
export const font = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
} as const;

/** The web's --radius (0.75rem) for cards, a smaller one for controls. */
export const radius = { card: 12, control: 8, pill: 999 } as const;

export interface Theme {
  /** The mode being drawn. */
  mode: Mode;
  dark: boolean;
  colors: Palette;
  /** What was chosen: may be `system`. */
  modeChoice: AppSettings['theme'];
  palette: AppSettings['palette'];
  setMode: (mode: AppSettings['theme']) => void;
  setPalette: (palette: AppSettings['palette']) => void;
}

export function useTheme(): Theme {
  const settings = useSettings();
  const mode: Mode = useColorScheme() === 'dark' ? 'dark' : 'light';
  return {
    mode,
    dark: mode === 'dark',
    colors: paletteColors(settings.palette, mode),
    modeChoice: settings.theme,
    palette: settings.palette,
    setMode: setTheme,
    setPalette,
  };
}
