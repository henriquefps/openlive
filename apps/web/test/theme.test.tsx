// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeMenu } from '../src/components/ThemeMenu.tsx';
import i18n from '../src/i18n/index.ts';
import {
  getPalette,
  initTheme,
  isPalette,
  PALETTE_STORAGE_KEY,
  readSavedPalette,
  readSavedTheme,
  THEME_STORAGE_KEY,
} from '../src/theme/theme.ts';

const html = document.documentElement;

async function choose(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Theme' }));
  await user.click(await screen.findByRole('menuitemradio', { name }));
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  initTheme();
});

afterEach(() => {
  html.classList.remove('light', 'dark');
  html.removeAttribute('data-palette');
  localStorage.clear();
});

describe('ThemeMenu', () => {
  it('starts on System: no class on <html>, so prefers-color-scheme decides', () => {
    render(<ThemeMenu />);
    expect(html.classList.contains('light')).toBe(false);
    expect(html.classList.contains('dark')).toBe(false);
  });

  it('sets the class on <html> and saves the choice for Dark, Light and System', async () => {
    render(<ThemeMenu />);

    await choose('Dark');
    expect(html.classList.contains('dark')).toBe(true);
    expect(html.classList.contains('light')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await choose('Light');
    expect(html.classList.contains('light')).toBe(true);
    expect(html.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    await choose('System');
    expect(html.classList.contains('light')).toBe(false);
    expect(html.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('marks the current choice as checked', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    initTheme();
    render(<ThemeMenu />);
    expect(html.classList.contains('dark')).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Theme' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

describe('readSavedTheme', () => {
  it('falls back to System for a missing or unknown value', () => {
    expect(readSavedTheme()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readSavedTheme()).toBe('system');
  });
});

describe('palettes', () => {
  it('starts on Olive: no data-palette attribute', () => {
    render(<ThemeMenu />);
    expect(html.hasAttribute('data-palette')).toBe(false);
    expect(getPalette()).toBe('olive');
  });

  it('sets data-palette, saves the choice and goes back to Olive with no attribute', async () => {
    render(<ThemeMenu />);
    await choose('Violet');
    expect(html.getAttribute('data-palette')).toBe('violet');
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('violet');
    await choose('Olive');
    expect(html.hasAttribute('data-palette')).toBe(false);
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('olive');
  });

  it('keeps the palette when the theme changes', async () => {
    render(<ThemeMenu />);
    await choose('Rose');
    await choose('Dark');
    expect(html.getAttribute('data-palette')).toBe('rose');
    expect(html.classList.contains('dark')).toBe(true);
  });

  it('applies the saved palette on init, with the theme-color meta following it', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#000000';
    document.head.append(meta);
    localStorage.setItem(PALETTE_STORAGE_KEY, 'blue');
    initTheme();
    expect(html.getAttribute('data-palette')).toBe('blue');
    expect(meta.content).not.toBe('#000000');
    meta.remove();
  });

  it('falls back to Olive for a missing or unknown value', () => {
    expect(readSavedPalette()).toBe('olive');
    localStorage.setItem(PALETTE_STORAGE_KEY, 'neon');
    expect(readSavedPalette()).toBe('olive');
    initTheme();
    expect(html.hasAttribute('data-palette')).toBe(false);
    expect(isPalette('neon')).toBe(false);
  });
});
