// SPDX-License-Identifier: AGPL-3.0-only
import { useColorScheme } from 'react-native';

// The hfps tokens of the web app (olive palette, Inter), as sRGB: React Native has no OKLCH.

export interface Palette {
  background: string;
  foreground: string;
  card: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  mutedForeground: string;
  destructive: string;
  warning: string;
  border: string;
}

const light: Palette = {
  background: '#f4f4f0',
  foreground: '#0c0c09',
  card: '#ffffff',
  primary: '#4c6f38',
  primaryForeground: '#fbfbf9',
  muted: '#f4f4f0',
  mutedForeground: '#6b6a56',
  destructive: '#d00114',
  warning: '#bb4d00',
  border: '#e8e8e3',
};

const dark: Palette = {
  background: '#0c0c09',
  foreground: '#fbfbf9',
  card: '#1d1d16',
  primary: '#8cb278',
  primaryForeground: '#0c0c09',
  muted: '#2b2b22',
  mutedForeground: '#abab9c',
  destructive: '#ff6467',
  warning: '#ffb900',
  border: 'rgba(255, 255, 255, 0.1)',
};

/** Inter, embedded at build time by the expo-font plugin (app.json). */
export const font = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
} as const;

/** The web's --radius (0.75rem) for cards, a smaller one for controls. */
export const radius = { card: 12, control: 8 } as const;

export interface Theme {
  dark: boolean;
  colors: Palette;
}

export function useTheme(): Theme {
  const isDark = useColorScheme() === 'dark';
  return { dark: isDark, colors: isDark ? dark : light };
}
