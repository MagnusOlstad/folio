import { expect, test } from '@playwright/test'
import type { MlxStatus } from '../../src/domain/types.ts'

const modelStatus = (): MlxStatus => ({
  available: true, helperAvailable: true, keepAliveMs: 60_000,
  installing: [], downloads: [], selectedGenerationModel: 'gemma4', activeModel: 'gemma4',
  models: [
    { id: 'gemma4', name: 'Gemma 4 E4B', purpose: 'generation', selected: true, installed: true, loaded: true, memory: { activeBytes: 3_210_000_000, cacheBytes: 420_000_000, peakResidentBytes: 3_760_000_000 }, downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true },
    { id: 'qwen35', name: 'Qwen 3.5 4B', purpose: 'generation', selected: false, installed: false, loaded: false, memory: null, downloadSizeBytes: 3_060_000_000, downloadSizeIsEstimate: true },
    { id: 'llama32', name: 'Llama 3.2 3B Instruct', purpose: 'generation', selected: false, installed: false, loaded: false, memory: null, downloadSizeBytes: 1_810_000_000, downloadSizeIsEstimate: true },
    { id: 'embeddinggemma', name: 'EmbeddingGemma', purpose: 'embeddings', selected: false, installed: true, loaded: true, memory: { activeBytes: 212_000_000, cacheBytes: 0, peakResidentBytes: 330_000_000 }, downloadSizeBytes: 212_000_000, downloadSizeIsEstimate: true },
    { id: 'whisper', name: 'Whisper', purpose: 'transcription', selected: false, installed: true, loaded: false, memory: null, downloadSizeBytes: 1_610_000_000, downloadSizeIsEstimate: true },
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
  await expect(panel.locator('.mlx-model')).toHaveCount(5)
  const orderedNames = () => grid.locator('.mlx-model-heading strong').allTextContents()
  await expect.poll(orderedNames).toEqual(['Gemma 4 E4B', 'EmbeddingGemma', 'Whisper', 'Qwen 3.5 4B', 'Llama 3.2 3B'])
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
  await panel.getByRole('button', { name: 'Stop Gemma 4 E4B' }).click()
  await expect(panel.getByRole('button', { name: 'Start Gemma 4 E4B' })).toBeEnabled()
  await panel.getByRole('button', { name: 'Start Whisper' }).focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('button', { name: 'Stop Whisper' })).toBeEnabled()
  expect(mutations).toEqual(['gemma4/unload', 'whisper/load'])
  await expect.poll(orderedNames).toEqual(['EmbeddingGemma', 'Whisper', 'Gemma 4 E4B', 'Qwen 3.5 4B', 'Llama 3.2 3B'])

  status = { ...status, models: status.models.map((model) => model.id === 'whisper' ? { ...model, busy: true, requestCount: 1 } : model) }
  await expect(panel.getByRole('button', { name: 'Stop Whisper' })).toBeDisabled()
  await expect(panel.getByText('1 active request')).toBeVisible()
  status = { ...status, activeModel: 'gemma4', models: status.models.map((model) => model.id === 'whisper' ? { ...model, loaded: false, busy: false, requestCount: 0 } : model.id === 'gemma4' ? { ...model, loaded: true } : model) }
  await expect(panel.getByRole('button', { name: 'Start Whisper' })).toBeEnabled()
  await expect(panel.getByRole('button', { name: 'Stop Gemma 4 E4B' })).toBeEnabled()

  await expect.poll(orderedNames).toEqual(['Gemma 4 E4B', 'EmbeddingGemma', 'Whisper', 'Qwen 3.5 4B', 'Llama 3.2 3B'])
  await grid.focus()
  await page.keyboard.press('End')
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await panel.getByRole('button', { name: 'Manage Qwen 3.5 4B' }).click()
  const settings = page.getByRole('region', { name: 'Local models' })
  await expect(settings).toBeVisible()
  const whisperRow = settings.locator('.model-settings-row').filter({ hasText: 'Whisper' })
  await expect(whisperRow.getByRole('button', { name: 'Remove' })).toBeEnabled()
  await expect(settings.getByRole('radio', { name: /Whisper/ })).toHaveCount(0)
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close', exact: true }).click()

  await page.locator('html').evaluate((element) => { element.setAttribute('data-theme', 'light') })
  await page.setViewportSize({ width: 850, height: 900 })
  await grid.evaluate((element) => { element.scrollTop = 0 })
  const narrowGrid = await grid.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }))
  expect(narrowGrid.height).toBeLessThanOrEqual(240)
  expect(narrowGrid.content).toBeGreaterThan(narrowGrid.height)
  const lightNarrowGridScreenshot = testInfo.outputPath('folio-model-grid-light-narrow.png')
  await panel.screenshot({ path: lightNarrowGridScreenshot })
  await testInfo.attach('model-grid-light-narrow', { path: lightNarrowGridScreenshot, contentType: 'image/png' })
  const lightNarrowWorkspaceScreenshot = testInfo.outputPath('folio-model-workspace-light-narrow.png')
  await page.screenshot({ path: lightNarrowWorkspaceScreenshot })
  await testInfo.attach('model-workspace-light-narrow', { path: lightNarrowWorkspaceScreenshot, contentType: 'image/png' })
  const bounds = await panel.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }))
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width)
})
