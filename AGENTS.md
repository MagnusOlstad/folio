# AGENTS.md

## Architecture

- React 19 + Vite + TypeScript frontend, Express API, and Electron shell.
- Keep `src/App.tsx` as composition only. Put orchestration in `src/app`, UI in `src/features`, lifecycle behavior in `src/hooks`, shared types in `src/domain`, and pure helpers/API clients in `src/lib`.
- Import feature modules directly; do not add barrel files or move feature logic back into a monolithic component.
- Styles load through `src/styles/app.css`; preserve import order and the existing cascade.

## Compatibility

- Preserve `/api` contracts, localStorage keys and recovery behavior, keyboard shortcuts, Markdown/OKF formats, and Electron/server behavior unless a task explicitly changes them.
- Use concrete TypeScript contracts; do not use `any` or `@ts-nocheck` to bridge component boundaries.
- Keep interaction logic in event handlers and effects for external synchronization/subscriptions. Parallelize independent requests, but avoid speculative memoization or new dependencies.

## Workflow

```sh
npm ci
npm run build
npm run lint
npm test
npm run test:ui
npm run test:e2e
```

- Add focused tests for extracted hooks, utilities, and behavior-sensitive components.
- Node integration and Playwright tests require loopback ports; Playwright also requires Chromium (`npx playwright install chromium`).
- Run `npm run test:e2e:local` only when Ollama and the configured local models are available.
- Keep `package-lock.json` synchronized with dependency changes and finish with `git diff --check`.
