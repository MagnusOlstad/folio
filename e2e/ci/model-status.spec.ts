import { expect, test } from '@playwright/test'
import type { MlxStatus } from '../../src/domain/types.ts'

const modelStatus = (): MlxStatus => ({
  available: true, helperAvailable: true, keepAliveMs: 60_000,
  installing: [], downloads: [], selectedGenerationModel: 'gemma4', selectedTranscriptionModel: 'whisper', activeModel: 'gemma4',
  models: [
    { id: 'gemma4', name: 'Gemma 4 E4B', purpose: 'generation', selected: true, installed: true, loaded: true, memory: { activeBytes: 3_210_000_000, cacheBytes: 420_000_000, peakResidentBytes: 3_760_000_000 }, downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true },
    { id: 'qwen35', name: 'Qwen 3.5 4B', purpose: 'generation', selected: false, installed: false, loaded: false, memory: null, downloadSizeBytes: 3_060_000_000, downloadSizeIsEstimate: true },
    { id: 'llama32', name: 'Llama 3.2 3B Instruct', purpose: 'generation', selected: false, installed: false, loaded: false, memory: null, downloadSizeBytes: 1_810_000_000, downloadSizeIsEstimate: true },
    { id: 'embeddinggemma', name: 'EmbeddingGemma', purpose: 'embeddings', selected: false, installed: true, loaded: true, memory: { activeBytes: 212_000_000, cacheBytes: 0, peakResidentBytes: 330_000_000 }, downloadSizeBytes: 212_000_000, downloadSizeIsEstimate: true },
    { id: 'whisper', name: 'Whisper Large v3 Turbo', purpose: 'transcription', selected: true, installed: true, loaded: false, memory: null, downloadSizeBytes: 1_610_000_000, downloadSizeIsEstimate: true },
    { id: 'whisperlarge', name: 'Whisper Large v3', purpose: 'transcription', selected: false, installed: false, loaded: false, memory: null, downloadSizeBytes: 3_100_000_000, downloadSizeIsEstimate: true },
  ],
})

test('toggles installed model blobs, follows automatic switches, and opens missing model settings', async ({ page }, testInfo) => {
  let status = modelStatus()
  const mutations: string[] = []
  await page.addInitScript(() => {
    localStorage.setItem('folio:model-setup-prompt-seen', '1')
    localStorage.setItem('folio:theme', 'dark')
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 950 })
  await page.route('**/api/mlx/status', (route) => route.fulfill({ json: status }))
  await page.route('**/api/mlx/models/*/*', (route) => {
    const [, id, action] = /\/models\/([^/]+)\/([^/]+)$/.exec(new URL(route.request().url()).pathname) ?? []
    mutations.push(`${id}/${action}`)
    status = { ...status, activeModel: action === 'load' ? id as MlxStatus['activeModel'] : null, models: status.models.map((model) => ({
      ...model, loaded: model.id === id ? action === 'load' : model.purpose === 'generation' || model.purpose === 'transcription' ? false : model.loaded,
      memory: model.id === id || model.purpose === 'generation' ? null : model.memory,
    })) }
    return route.fulfill({ json: status })
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Todo List', exact: true })).toBeVisible()
  const panel = page.getByRole('region', { name: 'MLX model management' })
  const grid = panel.getByRole('group', { name: 'Models, active first' })
  await expect(panel.locator('.mlx-model')).toHaveCount(6)
  const orderedNames = () => grid.locator('.mlx-model-heading strong').allTextContents()
  await expect.poll(orderedNames).toEqual(['Gemma 4 E4B', 'EmbeddingGemma', 'Whisper Turbo', 'Qwen 3.5 4B', 'Llama 3.2 3B', 'Whisper Large v3'])
  const gridSize = await grid.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }))
  expect(gridSize.height).toBeLessThanOrEqual(240)
  expect(gridSize.content).toBeGreaterThan(gridSize.height)
  const historySize = await page.locator('.right-pane-content').boundingBox()
  expect(historySize?.height).toBeGreaterThan(400)
  await expect(panel.getByRole('button', { name: 'Stop Gemma 4 E4B' })).toHaveAttribute('aria-pressed', 'true')
  const darkGridScreenshot = testInfo.outputPath('folio-model-grid-dark.png')
  await panel.screenshot({ path: darkGridScreenshot })
  await testInfo.attach('model-grid-dark', { path: darkGridScreenshot, contentType: 'image/png' })
  const darkWorkspaceScreenshot = testInfo.outputPath('folio-model-workspace-dark.png')
  await page.screenshot({ path: darkWorkspaceScreenshot })
  await testInfo.attach('model-workspace-dark', { path: darkWorkspaceScreenshot, contentType: 'image/png' })
  const running = panel.getByRole('button', { name: 'Stop Gemma 4 E4B' })
  const stopped = panel.getByRole('button', { name: 'Start Whisper Large v3 Turbo' })
  await expect(running).toHaveClass(/is-loaded/)
  await expect(stopped).toHaveClass(/is-stopped/)
  await expect(stopped.locator('.mlx-model-state')).toHaveText('■Stopped')
  expect(await running.evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).backgroundImage)).not.toBe(await stopped.evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).backgroundImage))
  expect(await stopped.locator('.model-orbit').evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).filter)).toBe('grayscale(1)')
  expect(await running.locator('.model-blob').evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).width)).toBe('25px')
  expect(await running.locator('.model-blob').evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await running.locator('.model-blob').evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).animationDuration)).toBe('2.5s')
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await panel.getByRole('button', { name: 'Collapse models' }).focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('button', { name: 'Expand models' })).toHaveAttribute('aria-expanded', 'false')
  await expect(grid).toBeHidden()
  await expect(panel.getByRole('button')).toHaveCount(2)
  await expect(panel.getByRole('status')).toHaveText('MLX · 2 running')
  const collapsedHistory = await page.locator('.right-pane-content').boundingBox()
  expect(collapsedHistory!.height).toBeGreaterThan(historySize!.height + 200)
  const stripBounds = await page.locator('.right-pane-status').boundingBox()
  const paneBounds = await page.locator('.workspace-right-pane').boundingBox()
  expect(stripBounds!.height).toBeLessThanOrEqual(36)
  expect(Math.abs(stripBounds!.y + stripBounds!.height - paneBounds!.y - paneBounds!.height)).toBeLessThanOrEqual(1)
  const darkCollapsedScreenshot = testInfo.outputPath('folio-model-collapsed-dark.png')
  await page.screenshot({ path: darkCollapsedScreenshot })
  await testInfo.attach('model-collapsed-dark', { path: darkCollapsedScreenshot, contentType: 'image/png' })
  status = { ...status, models: status.models.map((model) => model.id === 'gemma4' ? { ...model, loaded: false } : model) }
  await expect(panel.getByRole('status')).toHaveText('MLX · 1 running')
  status = modelStatus()
  await expect(panel.getByRole('status')).toHaveText('MLX · 2 running')
  await page.reload()
  await expect(panel.getByRole('button', { name: 'Expand models' })).toHaveAttribute('aria-expanded', 'false')
  await expect(panel.getByRole('status')).toHaveText('MLX · 2 running')
  await panel.getByRole('button', { name: 'Expand models' }).focus()
  await page.keyboard.press('Space')
  await expect(grid).toBeVisible()
  await panel.getByRole('button', { name: 'Stop Gemma 4 E4B' }).click()
  await expect(panel.getByRole('button', { name: 'Start Gemma 4 E4B' })).toBeEnabled()
  await panel.getByRole('button', { name: 'Start Whisper Large v3 Turbo' }).focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('button', { name: 'Stop Whisper Large v3 Turbo' })).toBeEnabled()
  expect(mutations).toEqual(['gemma4/unload', 'whisper/load'])
  await expect.poll(orderedNames).toEqual(['EmbeddingGemma', 'Whisper Turbo', 'Gemma 4 E4B', 'Qwen 3.5 4B', 'Llama 3.2 3B', 'Whisper Large v3'])

  status = { ...status, models: status.models.map((model) => model.id === 'whisper' ? { ...model, busy: true, requestCount: 1 } : model) }
  await expect(panel.getByRole('button', { name: 'Stop Whisper Large v3 Turbo' })).toBeDisabled()
  await expect(panel.getByText('1 active request')).toBeVisible()
  expect(await panel.getByRole('button', { name: 'Stop Whisper Large v3 Turbo' }).locator('.model-blob-core').evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await panel.getByRole('button', { name: 'Stop Whisper Large v3 Turbo' }).locator('.model-blob-core').evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).animationDuration)).toBe('1.8s')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  status = { ...status, activeModel: 'gemma4', models: status.models.map((model) => model.id === 'whisper' ? { ...model, loaded: false, busy: false, requestCount: 0 } : model.id === 'gemma4' ? { ...model, loaded: true } : model) }
  await expect(panel.getByRole('button', { name: 'Start Whisper Large v3 Turbo' })).toBeEnabled()
  await expect(panel.getByRole('button', { name: 'Stop Gemma 4 E4B' })).toBeEnabled()

  await expect.poll(orderedNames).toEqual(['Gemma 4 E4B', 'EmbeddingGemma', 'Whisper Turbo', 'Qwen 3.5 4B', 'Llama 3.2 3B', 'Whisper Large v3'])
  await grid.focus()
  await page.keyboard.press('End')
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await panel.getByRole('button', { name: 'Manage Qwen 3.5 4B' }).click()
  const settings = page.getByRole('region', { name: 'Local models' })
  await expect(settings).toBeVisible()
  const whisperRow = settings.locator('.model-settings-row').filter({ hasText: 'Whisper Large v3 Turbo' })
  await expect(whisperRow.getByRole('button', { name: 'Remove' })).toBeEnabled()
  await expect(settings.getByRole('radio', { name: /Whisper/ })).toHaveCount(2)
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close', exact: true }).click()

  await page.locator('html').evaluate((element) => { element.setAttribute('data-theme', 'light') })
  await page.setViewportSize({ width: 850, height: 900 })
  await grid.evaluate((element) => { element.scrollTop = 0 })
  const narrowGrid = await grid.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }))
  expect(narrowGrid.height).toBeLessThanOrEqual(240)
  expect(narrowGrid.content).toBeGreaterThan(narrowGrid.height)
  expect(await panel.getByRole('button', { name: 'Start Whisper Large v3 Turbo' }).evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).backgroundColor)).toBe('rgb(237, 240, 244)')
  const lightNarrowGridScreenshot = testInfo.outputPath('folio-model-grid-light-narrow.png')
  await panel.screenshot({ path: lightNarrowGridScreenshot })
  await testInfo.attach('model-grid-light-narrow', { path: lightNarrowGridScreenshot, contentType: 'image/png' })
  const lightNarrowWorkspaceScreenshot = testInfo.outputPath('folio-model-workspace-light-narrow.png')
  await page.screenshot({ path: lightNarrowWorkspaceScreenshot })
  await testInfo.attach('model-workspace-light-narrow', { path: lightNarrowWorkspaceScreenshot, contentType: 'image/png' })
  const bounds = await panel.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }))
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width)
  const lightHistory = await page.locator('.right-pane-content').boundingBox()
  await panel.getByRole('button', { name: 'Collapse models' }).click()
  await expect(panel.getByRole('status')).toHaveText('MLX · 2 running')
  const lightCollapsedHistory = await page.locator('.right-pane-content').boundingBox()
  expect(lightCollapsedHistory!.height).toBeGreaterThan(lightHistory!.height + 200)
  const lightStrip = await page.locator('.right-pane-status').boundingBox()
  const lightPane = await page.locator('.workspace-right-pane').boundingBox()
  expect(lightStrip!.height).toBeLessThanOrEqual(36)
  expect(Math.abs(lightStrip!.y + lightStrip!.height - lightPane!.y - lightPane!.height)).toBeLessThanOrEqual(1)
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const lightCollapsedScreenshot = testInfo.outputPath('folio-model-collapsed-light-narrow.png')
  await page.screenshot({ path: lightCollapsedScreenshot })
  await testInfo.attach('model-collapsed-light-narrow', { path: lightCollapsedScreenshot, contentType: 'image/png' })
  await panel.getByRole('button', { name: 'Manage', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Local models' })).toBeVisible()
})

test('selects, persists, downloads, and removes a missing transcription variant independently', async ({ page }) => {
  let status = modelStatus()
  const selections: string[] = []
  let selectionRequestCount = 0
  await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
  await page.route('**/api/mlx/status', (route) => route.fulfill({ json: status }))
  await page.route('**/api/mlx/models/transcription-selection', async (route) => {
    selectionRequestCount += 1
    expect(route.request().method()).toBe('PUT')
    const { id } = JSON.parse(route.request().postData() || '{}') as { id: 'whisper' | 'whisperlarge' }
    expect(id).toBe('whisperlarge')
    selections.push(id)
    status = { ...status, selectedTranscriptionModel: id, models: status.models.map((model) => ({ ...model, selected: model.id === id || model.id === status.selectedGenerationModel })) }
    await route.fulfill({ json: status })
  })
  await page.route('**/api/mlx/models/*/install', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) as 'whisper' | 'whisperlarge'
    status = { ...status, models: status.models.map((model) => model.id === id ? { ...model, installed: true } : model) }
    await route.fulfill({ json: status })
  })
  await page.route('**/api/mlx/models/*/remove', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) as 'whisper' | 'whisperlarge'
    status = { ...status, models: status.models.map((model) => model.id === id ? { ...model, installed: false, loaded: false } : model) }
    await route.fulfill({ json: status })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Local models' })
  const largeChoice = settings.getByRole('radio', { name: /Whisper Large v3.*3\.1 GB/ })
  await expect(largeChoice).not.toBeChecked()
  await largeChoice.click()
  await expect(largeChoice).toBeChecked()
  await expect(settings.getByRole('radio', { name: /Gemma 4/ })).toBeChecked()
  await expect(settings.getByRole('status')).toContainText('selected transcription model is not installed')
  expect(selections).toEqual(['whisperlarge'])
  expect(selectionRequestCount).toBe(1)
  await page.reload()
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  const persistedSettings = page.getByRole('region', { name: 'Local models' })
  await expect(persistedSettings.getByRole('radio', { name: /Whisper Large v3.*3\.1 GB/ })).toBeChecked()
  const largeRow = persistedSettings.getByRole('radio', { name: /Whisper Large v3.*3\.1 GB/ }).locator('xpath=ancestor::article')
  await largeRow.getByRole('button', { name: 'Download' }).click()
  await expect(largeRow.getByRole('button', { name: 'Remove' })).toBeEnabled()
  await largeRow.getByRole('button', { name: 'Remove' }).click()
  await expect(largeRow.getByRole('button', { name: 'Download' })).toBeEnabled()
  await expect(persistedSettings.getByRole('radio', { name: /Whisper Large v3.*3\.1 GB/ })).toBeChecked()
})
