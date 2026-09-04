import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.FOLIO_E2E_PORT || 4173)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node e2e/start-server.mjs',
    url: `${baseURL}/api/status`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { FOLIO_E2E_PORT: String(port) },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
