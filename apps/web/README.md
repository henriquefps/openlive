# @openlive/web

The Openlive web app: React + Vite + TypeScript, TanStack Router (code-based routes) and
TanStack Query, localized with `react-i18next`.

```sh
pnpm --filter @openlive/api dev   # API on http://localhost:8790
pnpm --filter @openlive/web dev   # web on http://localhost:5179, /api proxied to the API
```

## Localization

- Strings live in `packages/client/locales/<language>/translation.json` (`@openlive/client`, shared
  with the mobile app). `en` is the default and the fallback for any missing key; `pt-BR` is the
  other language.
- Language order: saved preference (`localStorage`, later `users.locale`) > browser language > `en`.
- The API returns error codes, never text. `translateError()` in `src/i18n/errors.ts` turns a code
  from `@openlive/protocol` plus its parameters into a sentence.
- Format numbers, units and dates with the `Intl` helpers in `src/i18n/format.ts`.
- `pnpm i18n:check` fails if a key is missing or extra in any locale, or a protocol error code has
  no translation. ESLint (`i18next/no-literal-string`) rejects literal text in JSX.

## Design system (`.claude/skills/hfps-app-ui`)

- Tailwind v4 and shadcn/ui: style `radix-vega`, base `radix`, base color `olive`, Phosphor icons
  (`components.json` is the skill's). Tokens live in `src/index.css` (the skill's `theme.css`,
  plus the local `--warning`, and `--player` for the video area, which is black in both themes).
- Inset layout: the top bar and the sidebar sit on `--background`; every page renders inside one
  `--card` surface (`SidebarInset`). Below 768 px the sidebar is a sheet.
- Theme: Light, Dark or System (`src/theme/theme.ts`). System follows `prefers-color-scheme`; a
  `light` or `dark` class on `<html>` overrides it. The choice is saved in `localStorage`.
- Status colors only through tokens: ok/live `primary`, paused/full `warning`, failed
  `destructive`, stopped `muted-foreground` (`StatusBadge`, `StreamCard`).
- `src/components/ui/` is shadcn source added by its CLI. After `pnpm dlx shadcn@latest add`,
  replace any `from "cn"` import with `@/lib/utils`, remove the `cn` package it adds, run
  Prettier, and keep the label props added to `sidebar.tsx` and `sheet.tsx` (no English literals).
- `/dev/components` shows `StreamCard` and `StatusBadge` with fixture data. It exists in the dev
  server and in `vite build --mode development`; a production build drops it.

Before calling a screen done, check 390, 1024, 1280 and 1440 px in light and dark:

```sh
pnpm exec vite build --mode development && pnpm preview   # http://localhost:5179
```

Screenshots go to `apps/web/screenshots/` (git-ignored).
