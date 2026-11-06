// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Pictographs (emojis, dingbats), arrows and angle quotes used as icons; not × or ·, which are text.
const EMOJI_GLYPH = String.raw`/[\p{Extended_Pictographic}\u2190-\u21FF\u2039\u203A\u25B6\u25C0]/u`;

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
      // Native projects that `expo prebuild` generates in the mobile app.
      'apps/mobile/android/',
      'apps/mobile/ios/',
      'apps/mobile/.expo/',
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
    // User-visible text comes from packages/client/locales, never from literals in JSX.
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
    files: ['apps/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // The mobile app's text comes from apps/mobile/src/i18n/locales, as on the web.
    files: ['apps/mobile/src/**/*.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          'jsx-attributes': {
            // Full-match patterns: non-text props of the React Native components.
            exclude: [
              'style',
              'key',
              'testID',
              'variant',
              'tone',
              'accessibilityRole',
              'accessibilityLiveRegion',
              'size',
              'autoCapitalize',
              'behavior',
              'keyboardShouldPersistTaps',
              'autoComplete',
              'keyboardType',
              'inputMode',
              'returnKeyType',
              'facing',
              'weight',
            ],
          },
        },
      ],
    },
  },
  {
    // Never emojis or symbol glyphs as icons (Henrique's rule, 2026-11-03): icons are Phosphor
    // (@phosphor-icons/react on the web, phosphor-react-native in the app). Message text a person
    // typed is data, not UI, and never appears as a literal; tests may use emojis as fixtures.
    files: ['apps/mobile/src/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/__fixtures__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          ['Literal', 'value'],
          ['TemplateElement', 'value.raw'],
          ['JSXText', 'value'],
        ].map(([type, field]) => ({
          selector: `${type}[${field}=${EMOJI_GLYPH}]`,
          message: 'No emoji or symbol glyph as an icon: use a Phosphor icon.',
        })),
      ],
    },
  },
  {
    // shadcn/ui source added by its CLI: no user-visible text except sr-only labels, which take
    // props instead (see the Sidebar's mobile sheet title).
    files: ['apps/web/src/components/ui/**/*.tsx'],
    rules: { 'i18next/no-literal-string': 'off' },
  },
  {
    // @openlive/client runs in the browser, React Native and Node tests:
    // no DOM, no Node modules, no React. The platform's fetch, WebSocket and timers are fine.
    files: ['packages/client/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage'].map(
          (name) => ({ name, message: 'Not in React Native: take it as an option.' }),
        ),
        ...['process', 'Buffer', 'require'].map((name) => ({
          name,
          message: 'Node only: not in the browser or React Native.',
        })),
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Node only: not in the browser or React Native.' },
            {
              group: ['react', 'react-*', '@tanstack/*', 'i18next'],
              message: 'UI stays in the apps.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
