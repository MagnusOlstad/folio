# AGENTS.md

## Architecture

- React 19 + Vite + TypeScript frontend, Express API, and Electron shell.
- Keep `src/App.tsx` and `src/app` as composition only. Colocate workspace UI, hooks, and pure state transitions under `src/features/workspace/{components,hooks,model}`; reserve `src/hooks` for cross-feature lifecycle behavior, `src/domain` for shared types, and `src/lib` for pure helpers/API clients.
- Import feature modules directly; do not add barrel files or move feature logic back into a monolithic component.
- Styles load through `src/styles/app.css`; preserve import order and the existing cascade.

## Agent Use

- Codex agents only: prefer GPT-5.6 Sol for scoping, orchestration, review, and final validation; prefer GPT-5.6 Terra at medium reasoning for bounded, substantive implementation. This is advisory: use one agent for small or tightly coupled changes and adjust model or effort when risk warrants it. Other agents should ignore this model-selection guidance.
- Default to one implementer. Parallelize only independent, non-overlapping work. Delegate relevant paths, constraints, and acceptance criteria instead of full conversation history.
- Handoffs should list changed files, decisions, checks, and unresolved issues without passing logs. In Codex workflows, Sol should review the diff and focused evidence without repeating discovery or passing checks; use focused follow-ups for rework.

## Skills

- For substantive React architecture or performance work, use `vercel-react-best-practices` when available. Do not search for or block on it, or load it for routine validation, documentation, styling, or small edits.
- Apply the skill's React guidance that is relevant to this React 19 + Vite application. Do not apply Next.js-specific guidance unless the task explicitly introduces Next.js code.
- Repository instructions and explicit user requirements take precedence over general skill guidance.

## Compatibility

- Preserve `/api` contracts, localStorage keys and recovery behavior, keyboard shortcuts, Markdown/OKF formats, and Electron/server behavior unless a task explicitly changes them.
- Use concrete TypeScript contracts; do not use `any` or `@ts-nocheck` to bridge component boundaries.
- Keep interaction logic in event handlers and effects for external synchronization/subscriptions. Parallelize independent requests, but avoid speculative memoization or new dependencies.

## Workflow

- Use the smallest meaningful verification set. Broaden only when affected boundaries, failures, unresolved risk, or the user justify it.
- Run `npm ci` only when dependencies are missing or `package.json`/`package-lock.json` changed.
- Documentation-only changes need review plus `git diff --check`, not application tests. For localized code changes, run the nearest Node or Vitest files and lint affected paths when practical.
- Run `npm run build` for changes affecting TypeScript contracts, imports, bundling, or production output. Run `npm run test:e2e` only for affected cross-layer flows, browser/Electron behavior, or explicit requests; build first.
- Run the full build, lint, Node, UI, and E2E matrix once for broad, high-risk, release-related, or explicitly requested changes. Otherwise rely on CI for the exhaustive matrix.
- Rerun only failed or affected checks unless later edits invalidate a pass. Keep output concise and inspect only relevant failure sections.
- Add tests for new behavior, regressions, and extracted logic with a meaningful contract. Avoid tests that only mirror reversible, low-impact implementation details.
- Node integration and Playwright tests require loopback ports; Playwright also requires Chromium (`npx playwright install chromium`).
- Run `npm run test:e2e:local` only when Ollama and the configured local models are available.
- Keep `package-lock.json` synchronized with dependency changes and finish with `git diff --check`.
