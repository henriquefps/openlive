## What and why

<!-- What this changes and the problem it solves. Link the issue: "Fixes #123". -->

## How it was tested

<!-- Commands you ran and what you checked by hand (browser, desktop, GPU). -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`; the DCO in CONTRIBUTING.md)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm i18n:check` and `pnpm spdx:check` pass
- [ ] Helper changes: `go test ./...` and `golangci-lint run` in `helper/`
- [ ] User-visible text is in both locales; protocol changes start in `packages/protocol` and `docs/PROTOCOL.md`
- [ ] Docs, and the reasoning for a decision that sets a direction, are updated
