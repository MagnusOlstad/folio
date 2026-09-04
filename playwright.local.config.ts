import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.FOLIO_E2E_PORT || 4174)
const baseURL = `http://127.0.0.1:${port}`

// The broader, slower suite: exercises real capture classification, semantic
// search, and Ask against a real local Ollama. Not run in CI (runners don't
// have Ollama) - this is meant for `npm run test:e2e:local`, normally invoked
// by the pre-push hook (see .githooks/pre-push).
export default defineConfig({
  testDir: './e2e/local',
  globalSetup: './e2e/local/global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/start-server-local.mjs',
    url: `${baseURL}/api/status`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { FOLIO_E2E_PORT: String(port) },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
