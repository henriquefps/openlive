// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/.wrangler/',
      '**/worker-configuration.d.ts',
      'experiments/',
      // Flatpak builds of the helper (packaging/linux/README.md) copy the repository there.
      'build/',
      '.flatpak-builder/',
      // Vendored agent skills (copied as is, like .prettierignore).
      '.claude/skills/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // User-visible text comes from apps/web/src/locales, never from literals in JSX.
    files: ['apps/web/src/**/*.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          'jsx-attributes': {
            // Full-match patterns: non-text props of the shadcn/ui and Radix components.
            exclude: [
              'className',
              'style',
              'type',
              'key',
              'id',
              'to',
              'href',
              'lang',
              'rel',
              'data-.*',
              'variant',
              'size',
              'side',
              'align',
              'orientation',
              'collapsible',
              'role',
              'value',
              'weight',
              'autoComplete',
              'autoCapitalize',
              'inputMode',
              'position',
              'tone',
              'heading',
              'htmlFor',
              'inputMode',
              'aria-labelledby',
            ],
          },
        },
      ],
    },
  },
  {
    // shadcn/ui source added by its CLI: no user-visible text except sr-only labels, which take
    // props instead (see the Sidebar's mobile sheet title).
    files: ['apps/web/src/components/ui/**/*.tsx'],
    rules: { 'i18next/no-literal-string': 'off' },
  },
  prettier,
);
