// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  avatarFileProblem,
  avatarSource,
  DISPLAY_NAME_MAX,
  MAX_AVATAR_INPUT_BYTES,
  nameProblem,
  squareCrop,
} from '../src/lib/avatar.ts';
import {
  DEFAULT_SETTINGS,
  forcedScheme,
  LANGUAGE_KEY,
  loadSettings,
  resolveLanguage,
  THEME_KEY,
} from '../src/lib/settings.ts';
import { instanceRemoved, sessionLost, settingsRoute } from '../src/lib/navigation.ts';

const store = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null });

describe('settings', () => {
  it('reads the saved choices and falls back to the system', () => {
    expect(loadSettings(store({}))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(store({ [THEME_KEY]: 'dark', [LANGUAGE_KEY]: 'pt-BR' }))).toEqual({
      theme: 'dark',
      language: 'pt-BR',
    });
    expect(loadSettings(store({ [THEME_KEY]: 'neon', [LANGUAGE_KEY]: 'fr' }))).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it('resolves the language', () => {
    expect(resolveLanguage('system', ['pt-PT'])).toBe('pt-BR');
    expect(resolveLanguage('system', ['de-DE'])).toBe('en');
    expect(resolveLanguage('en', ['pt-BR'])).toBe('en');
    expect(resolveLanguage('pt-BR', [])).toBe('pt-BR');
  });

  it('forces a color scheme only when the theme is not the system', () => {
    expect(forcedScheme('system')).toBe('auto');
    expect(forcedScheme('light')).toBe('light');
    expect(forcedScheme('dark')).toBe('dark');
  });
});

describe('profile photo', () => {
  it('crops the centred square', () => {
    expect(squareCrop(400, 300)).toEqual({ originX: 50, originY: 0, width: 300, height: 300 });
    expect(squareCrop(300, 301)).toEqual({ originX: 0, originY: 0, width: 300, height: 300 });
    expect(squareCrop(100, 100)).toEqual({ originX: 0, originY: 0, width: 100, height: 100 });
  });

  it('refuses pictures over 5 MB, and trusts an unknown size', () => {
    expect(avatarFileProblem(MAX_AVATAR_INPUT_BYTES)).toBeNull();
    expect(avatarFileProblem(MAX_AVATAR_INPUT_BYTES + 1)).toBe('size');
    expect(avatarFileProblem(undefined)).toBeNull();
  });

  it('checks the name like the API', () => {
    expect(nameProblem('  ')).toBe('required');
    expect(nameProblem(' Ana ')).toBeNull();
    expect(nameProblem('x'.repeat(DISPLAY_NAME_MAX))).toBeNull();
    expect(nameProblem('x'.repeat(DISPLAY_NAME_MAX + 1))).toBe('tooLong');
  });

  it('loads an uploaded photo from the server with the token, others as they are', () => {
    const headers = { Authorization: 'Bearer t' };
    expect(avatarSource('https://cdn.discordapp.com/a.png', null, null)).toEqual({
      uri: 'https://cdn.discordapp.com/a.png',
    });
    expect(avatarSource('/api/avatars/u1/v2', 'https://o.example/', headers)).toEqual({
      uri: 'https://o.example/api/avatars/u1/v2',
      headers,
    });
    expect(avatarSource('/api/avatars/u1/v2', 'https://o.example', null)).toBeNull();
  });
});

describe('settings route', () => {
  const A = 'https://a.example';
  const B = 'https://b.example';
  it('goes back to the server screen when its session ends', () => {
    const stack = [{ name: 'home' }, { name: 'instance', origin: A }, settingsRoute(A)] as const;
    expect(sessionLost(stack, A)).toEqual([
      { name: 'home' },
      { name: 'instance', origin: A, expired: true },
    ]);
  });

  it('leaves the app settings alone and drops a removed server', () => {
    const app = [{ name: 'home' }, settingsRoute()] as const;
    expect(sessionLost(app, A)).toBe(app);
    expect(instanceRemoved(app, A)).toEqual(app);
    expect(
      instanceRemoved([{ name: 'home' }, { name: 'instance', origin: B }, settingsRoute(B)], B),
    ).toEqual([{ name: 'home' }]);
  });
});
