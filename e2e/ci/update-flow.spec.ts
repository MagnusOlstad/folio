import { expect, test } from '@playwright/test'

type MockUpdateState = { status: string; version: string; percent: number | null; error: string | null }
type MockUpdateListener = (state: MockUpdateState) => void

test('desktop update badge starts a background download and reports restart progress', async ({ page }) => {
  await page.route(/\/api\/version(?:\?.*)?$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: '0.6.0',
      repo: 'MagnusOlstad/folio',
      latest: '0.7.0',
      latestUrl: 'https://github.com/MagnusOlstad/folio/releases/tag/v0.7.0',
      updateAvailable: true,
    }),
  }))
  await page.addInitScript(() => {
    let state: MockUpdateState = { status: 'available', version: '0.7.0', percent: null, error: null }
    const listeners = new Set<MockUpdateListener>()
    const publish = (next: MockUpdateState) => {
      state = next
      listeners.forEach((listener) => listener(state))
    }
    Object.defineProperty(globalThis, 'folio', {
      configurable: true,
      value: {
        getUpdateState: async () => state,
        onUpdateState: (listener: MockUpdateListener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        startUpdate: async () => {
          publish({ status: 'downloading', version: '0.7.0', percent: 33, error: null })
          return state
        },
      },
    })
  })

  await page.goto('/')
  const badge = page.getByRole('button', { name: 'Download update: version 0.7.0' })
  await expect(badge).toBeVisible()
  await badge.click()
  await expect(page.getByRole('button', { name: 'Downloading 33%: version 0.7.0' })).toBeDisabled()
  await expect(page.locator('.update-spinner')).toBeVisible()
})
