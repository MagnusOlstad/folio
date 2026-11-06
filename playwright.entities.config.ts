import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.FOLIO_ENTITIES_E2E_PORT || 4174)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e/entities',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: {
    command: 'node e2e/start-server-entities.mjs',
    url: `${baseURL}/api/status`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { FOLIO_ENTITIES_E2E_PORT: String(port) },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
