import { expect, test } from '@playwright/test'

type MockUpdateState = { status: string; version: string | null; percent: number | null; error: string | null }
type MockUpdateListener = (state: MockUpdateState) => void

declare global {
  interface Window {
    __publishUpdateState?: (state: MockUpdateState) => void
    __updateListenerCount?: () => number
    __updateSettingsChecks?: number
    __updateStarts?: number
  }
}

test('update arrival and download progress survive both panes being collapsed', async ({ page }) => {
  await page.route(/\/api\/version(?:\?.*)?$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: '0.6.0',
      repo: 'MagnusOlstad/folio',
      latest: null,
      updateAvailable: false,
    }),
  }))
  await page.addInitScript(() => {
    const browserWindow = globalThis as unknown as Window
    let state: MockUpdateState = { status: 'checking', version: null, percent: null, error: null }
    const listeners = new Set<MockUpdateListener>()
    const publish = (next: MockUpdateState) => {
      state = next
      listeners.forEach((listener) => listener(state))
    }
    Object.defineProperty(browserWindow, '__publishUpdateState', { value: publish })
    Object.defineProperty(browserWindow, '__updateListenerCount', { value: () => listeners.size })
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
  await expect(page.getByRole('button', { name: 'Download update: version 0.7.0' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Hide right sidebar' }).click()
  await page.getByRole('button', { name: 'Hide left sidebar' }).click()
  const expandRightPane = page.getByRole('button', { name: 'Show right sidebar' })
  await expect(expandRightPane).toBeVisible()
  await expect(expandRightPane).not.toHaveAttribute('title', /update is available/)

  await page.evaluate(() => (globalThis as unknown as Window).__publishUpdateState?.({ status: 'available', version: '0.7.0', percent: null, error: null }))
  await expect(expandRightPane).toHaveAttribute('title', 'Show right sidebar. An update is available.')
  await expect(expandRightPane.locator('.update-available-dot')).toBeVisible()
  expect(await page.evaluate(() => (globalThis as unknown as Window).__updateListenerCount?.())).toBe(1)

  await expandRightPane.click()
  const rightHeader = page.locator('.right-pane-header')
  await expect(rightHeader.getByText('v0.6.0')).toBeVisible()
  const badge = page.getByRole('button', { name: 'Download update: version 0.7.0' })
  await expect(badge).toBeVisible()
  await badge.click()
  await expect(page.getByRole('button', { name: 'Downloading 33%: version 0.7.0' })).toBeDisabled()

  await page.getByRole('button', { name: 'Hide right sidebar' }).click()
  await expect(expandRightPane.locator('.update-available-dot')).toBeVisible()
  await expandRightPane.click()
  await expect(page.getByRole('button', { name: 'Downloading 33%: version 0.7.0' })).toBeDisabled()
  await expect(page.locator('.update-spinner')).toBeVisible()
})

test('the collapsed pane signals an API release update', async ({ page }) => {
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
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Update to version 0.7.0' })).toBeVisible()
  await page.getByRole('button', { name: 'Hide right sidebar' }).click()
  const expandRightPane = page.getByRole('button', { name: 'Show right sidebar' })
  await expect(expandRightPane).toHaveAttribute('title', 'Show right sidebar. An update is available.')
  await expect(expandRightPane.locator('.update-available-dot')).toBeVisible()
})

test('settings retries a failed update and locks controls while installing', async ({ page }) => {
  await page.addInitScript(() => {
    const browserWindow = globalThis as unknown as Window
    let state: MockUpdateState = { status: 'idle', version: null, percent: null, error: null }
    const listeners = new Set<MockUpdateListener>()
    const publish = (next: MockUpdateState) => {
      state = next
      listeners.forEach((listener) => listener(state))
    }
    Object.defineProperty(browserWindow, '__publishUpdateState', { value: publish })
    Object.defineProperty(browserWindow, '__updateSettingsChecks', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(browserWindow, '__updateStarts', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(globalThis, 'folio', {
      configurable: true,
      value: {
        getUpdateState: async () => state,
        checkForUpdates: async () => {
          browserWindow.__updateSettingsChecks = (browserWindow.__updateSettingsChecks ?? 0) + 1
          publish({ status: 'available', version: '0.9.0', percent: null, error: null })
          return state
        },
        startUpdate: async () => {
          browserWindow.__updateStarts = (browserWindow.__updateStarts ?? 0) + 1
          if (browserWindow.__updateStarts === 1) {
            publish({ status: 'error', version: '0.9.0', percent: null, error: 'Could not download update. Try again.' })
            throw new Error('Could not download update. Try again.')
          }
          publish({ status: 'downloading', version: '0.9.0', percent: 20, error: null })
          return state
        },
        onUpdateState: (listener: MockUpdateListener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Updates' }).click()
  const updates = settings.getByRole('region', { name: 'Updates settings' })
  await updates.getByRole('button', { name: 'Check for updates' }).click()
  await expect(updates.getByRole('button', { name: 'Download and install v0.9.0' })).toBeVisible()
  expect(await page.evaluate(() => (globalThis as unknown as Window).__updateSettingsChecks)).toBe(1)

  await updates.getByRole('button', { name: 'Download and install v0.9.0' }).click()
  await expect(updates.getByRole('button', { name: 'Retry update' })).toBeVisible()
  await expect(updates.getByRole('alert').first()).toHaveText('Could not download update. Try again.')
  expect(await page.evaluate(() => (globalThis as unknown as Window).__updateStarts)).toBe(1)

  await updates.getByRole('button', { name: 'Retry update' }).click()
  await expect(updates.getByRole('progressbar', { name: 'Downloading update' })).toHaveAttribute('value', '20')
  await expect(updates.getByText('Downloading update: 20%')).toBeVisible()
  await expect(updates.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
  expect(await page.evaluate(() => (globalThis as unknown as Window).__updateStarts)).toBe(2)

  await page.evaluate(() => (globalThis as unknown as Window).__publishUpdateState?.({ status: 'staging', version: '0.9.0', percent: null, error: null }))
  await expect(updates.getByText('Preparing installation…')).toBeVisible()
  await expect(updates.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
  await expect(updates.getByRole('button', { name: /Download and install|Retry update/ })).toHaveCount(0)

  await page.evaluate(() => (globalThis as unknown as Window).__publishUpdateState?.({ status: 'installing', version: '0.9.0', percent: null, error: null }))
  await expect(updates.getByText('Restarting FolioNotes to install the update…')).toBeVisible()
  await expect(updates.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
  await expect(updates.getByText('FolioNotes will save pending changes before restarting to finish installation.')).toBeVisible()
})
