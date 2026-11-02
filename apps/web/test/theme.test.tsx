// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeMenu } from '../src/components/ThemeMenu.tsx';
import i18n from '../src/i18n/index.ts';
import { initTheme, readSavedTheme, THEME_STORAGE_KEY } from '../src/theme/theme.ts';

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
