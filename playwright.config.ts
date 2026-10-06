import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.FOLIO_E2E_PORT || 4173)
const baseURL = `http://127.0.0.1:${port}`

// This is the narrow, CI-safe suite: real server and seeded temp data, so it is
// fast and deterministic on a runner with no locally installed models. It's what
// `npm run test:e2e` and the GitHub Actions `e2e` job run.
//
// The broader suite that exercises real MLX capture/search/ask lives in
// e2e/local and runs via `npm run test:e2e:local` (see playwright.local.config.ts)
// - normally from the pre-push hook, since it needs the models installed locally
// and isn't something CI runners have.
export default defineConfig({
  testDir: './e2e/ci',
  // Every browser test talks to the same seeded server and mutable bundle.
  // Parallel specs can edit, move, or delete one another's notes while the
  // server is reindexing them, so keep this shared fixture single-writer.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node e2e/start-server-ci.mjs',
    url: `${baseURL}/api/status`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { FOLIO_E2E_PORT: String(port) },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
