import { expect, test } from '@playwright/test'
import type { MlxStatus } from '../../src/domain/types.ts'
import type { Page } from '@playwright/test'

const configuredStatus = (): MlxStatus => ({
  available: true,
  helperAvailable: true,
  keepAliveMs: 60_000,
  installing: ['llama32'],
  downloads: [{ id: 'llama32', progress: { downloadedBytes: 400_000_000, totalBytes: 1_800_000_000, percent: 22, phase: 'downloading' } }],
  selectedGenerationModel: 'gemma4',
  selectedTranscriptionModel: 'whisper',
  activeModel: 'gemma4',
  models: [
    { id: 'gemma4', name: 'Gemma 4 E4B', purpose: 'generation', selected: true, installed: true, loaded: true, memory: { activeBytes: 3_210_000_000, cacheBytes: 420_000_000, peakResidentBytes: 3_760_000_000 }, downloadSizeBytes: 5_180_000_000, downloadSizeIsEstimate: true },
    { id: 'qwen35', name: 'Qwen 3.5 4B', purpose: 'generation', selected: false, installed: true, loaded: true, busy: true, requestCount: 1, memory: null, downloadSizeBytes: 3_060_000_000, downloadSizeIsEstimate: true },
    { id: 'llama32', name: 'Llama 3.2 3B Instruct', purpose: 'generation', selected: false, installed: false, loaded: false, memory: null, downloadSizeBytes: 1_810_000_000, downloadSizeIsEstimate: true },
    { id: 'embeddinggemma', name: 'EmbeddingGemma', purpose: 'embeddings', selected: false, installed: true, loaded: true, memory: { activeBytes: 212_000_000, cacheBytes: 0, peakResidentBytes: 330_000_000 }, downloadSizeBytes: 212_000_000, downloadSizeIsEstimate: true },
    { id: 'whisper', name: 'Whisper Large v3 Turbo', purpose: 'transcription', selected: true, installed: true, loaded: true, memory: null, downloadSizeBytes: 1_610_000_000, downloadSizeIsEstimate: true },
    { id: 'whisperlarge', name: 'Whisper Large v3', purpose: 'transcription', selected: false, installed: true, loaded: true, memory: null, downloadSizeBytes: 3_100_000_000, downloadSizeIsEstimate: true },
  ],
})

async function resizeRightPane(page: Page, width: number) {
  const workspace = page.locator('.workspace')
  const workspaceBounds = await workspace.boundingBox()
  const handle = page.getByRole('separator', { name: 'Resize right sidebar' })
  const handleBounds = await handle.boundingBox()
  expect(workspaceBounds).not.toBeNull()
  expect(handleBounds).not.toBeNull()
  const y = handleBounds!.y + handleBounds!.height / 2
  await page.mouse.move(handleBounds!.x + 3, y)
  await page.mouse.down()
  await page.mouse.move(workspaceBounds!.x + workspaceBounds!.width - width, y, { steps: 8 })
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow', String(width))
}

async function dragPanelTop(page: Page, handleName: string, panelSelector: string) {
  const handle = page.getByRole('separator', { name: handleName })
  const panel = page.locator(panelSelector)
  const before = await panel.boundingBox()
  const handleBounds = await handle.boundingBox()
  expect(before).not.toBeNull()
  expect(handleBounds).not.toBeNull()
  const startX = handleBounds!.x + handleBounds!.width / 2
  const startY = handleBounds!.y + handleBounds!.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY - 64, { steps: 8 })
  await page.mouse.up()
  const after = await panel.boundingBox()
  expect(after!.height).toBeGreaterThan(before!.height + 40)
  await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round(after!.height)))
  return after!.height
}

test('workspace model rows follow settings and stay readable in wide and narrow panes', async ({ page }, testInfo) => {
  let status = configuredStatus()
  await page.addInitScript(() => {
    localStorage.setItem('folio:model-setup-prompt-seen', '1')
    localStorage.setItem('folio:model-panel-collapsed', '0')
    localStorage.setItem('folio:recent-concepts-collapsed', 'false')
  })
  await page.route('**/api/mlx/status', (route) => route.fulfill({ json: status }))
  await page.route('**/api/mlx/models/selection', async (route) => {
    const { id } = JSON.parse(route.request().postData() || '{}') as { id: 'gemma4' | 'qwen35' | 'llama32' }
    status = { ...status, selectedGenerationModel: id, models: status.models.map((model) => ({ ...model, selected: model.id === id || model.id === status.selectedTranscriptionModel })) }
    await route.fulfill({ json: status })
  })
  await page.route('**/api/mlx/models/transcription-selection', async (route) => {
    const { id } = JSON.parse(route.request().postData() || '{}') as { id: 'whisper' | 'whisperlarge' }
    status = { ...status, selectedTranscriptionModel: id, models: status.models.map((model) => ({ ...model, selected: model.id === id || model.id === status.selectedGenerationModel })) }
    await route.fulfill({ json: status })
  })
  await page.route('**/api/mlx/models/*/*', async (route) => {
    const [, id, action] = /\/models\/([^/]+)\/([^/]+)$/.exec(new URL(route.request().url()).pathname) ?? []
    status = { ...status, activeModel: action === 'load' ? id as MlxStatus['activeModel'] : null, models: status.models.map((model) => model.id === id ? { ...model, loaded: action === 'load', memory: action === 'unload' ? null : model.memory ?? (id === 'gemma4' ? { activeBytes: 3_210_000_000, cacheBytes: 420_000_000, peakResidentBytes: 3_760_000_000 } : null) } : model) }
    await route.fulfill({ json: status })
  })

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'dark'))
  await expect(page.getByRole('button', { name: 'Todo List', exact: true })).toBeVisible()
  const panel = page.getByRole('region', { name: 'MLX model management' })
  const rows = panel.locator('.mlx-model')
  const names = () => panel.locator('.mlx-model-heading strong').allTextContents()
  await expect(rows).toHaveCount(3)
  await expect.poll(names).toEqual(['Gemma 4 E4B', 'EmbeddingGemma', 'Whisper Turbo'])
  await expect(panel.getByRole('button', { name: 'Stop Qwen 3.5 4B' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /Llama 3\.2/ })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /Start Whisper Large v3$/ })).toHaveCount(0)
  const defaultColumns = await rows.first().evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(defaultColumns).toBe(3)
  const defaultFooter = await page.locator('.right-pane-status').boundingBox()
  expect(defaultFooter!.height).toBeLessThanOrEqual(340)
  for (const row of await rows.all()) {
    const rowBounds = await row.boundingBox()
    expect(rowBounds!.y + rowBounds!.height).toBeLessThanOrEqual(defaultFooter!.y + defaultFooter!.height)
  }
  await resizeRightPane(page, 420)
  const widePaneWidth = await page.locator('.workspace-right-pane').evaluate((element) => element.clientWidth)
  expect(widePaneWidth).toBeGreaterThan(360)
  const widePanelWidth = await page.locator('.right-pane-status').evaluate((element) => element.clientWidth)
  expect(widePanelWidth).toBeGreaterThan(360)
  const wideGridColumns = await rows.first().evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(wideGridColumns).toBe(4)
  const wideRowStyle = await rows.first().evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).display)
  expect(wideRowStyle).toBe('grid')
  const darkWideScreenshot = testInfo.outputPath('mlx-horizontal-rows-dark-wide.png')
  await panel.screenshot({ path: darkWideScreenshot })
  await testInfo.attach('mlx-horizontal-rows-dark-wide', { path: darkWideScreenshot, contentType: 'image/png' })

  const gemma = panel.getByRole('button', { name: 'Stop Gemma 4 E4B' })
  const loadedHeight = (await gemma.boundingBox())!.height
  await gemma.click()
  const unloaded = panel.getByRole('button', { name: 'Start Gemma 4 E4B' })
  await expect(unloaded.locator('.mlx-model-details').locator('span').first()).toHaveText('~5.18 GB on launch')
  expect(Math.abs((await unloaded.boundingBox())!.height - loadedHeight)).toBeLessThanOrEqual(2)

  await resizeRightPane(page, 220)
  const narrowUnloadedHeight = (await unloaded.boundingBox())!.height
  await unloaded.click()
  const narrowLoaded = panel.getByRole('button', { name: 'Stop Gemma 4 E4B' })
  await expect(narrowLoaded.locator('.mlx-model-details').locator('span').first()).toHaveText('3.21 GB active')
  expect(Math.abs((await narrowLoaded.boundingBox())!.height - narrowUnloadedHeight)).toBeLessThanOrEqual(2)

  await panel.getByRole('button', { name: 'Manage', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Local models' })
  const qwenChoice = settings.getByRole('radio', { name: /Qwen 3\.5 4B/ })
  await qwenChoice.click()
  await expect(qwenChoice).toBeChecked()
  const whisperLargeChoice = settings.getByRole('radio', { name: /Whisper Large v3.*3\.1 GB/ })
  await whisperLargeChoice.click()
  await expect(whisperLargeChoice).toBeChecked()
  await expect.poll(names).toEqual(['Qwen 3.5 4B', 'EmbeddingGemma', 'Whisper Large v3'])
  await expect(panel.getByRole('button', { name: 'Stop Qwen 3.5 4B' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: /Llama 3\.2/ })).toHaveCount(0)
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close', exact: true }).click()

  await page.locator('html').evaluate((element) => {
    element.setAttribute('data-theme', 'light')
  })
  await resizeRightPane(page, 220)
  const narrowMetrics = await panel.evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
  expect(narrowMetrics.width).toBeLessThanOrEqual(230)
  expect(narrowMetrics.scrollWidth).toBeLessThanOrEqual(narrowMetrics.width)
  for (const row of await rows.all()) {
    const bounds = await row.boundingBox()
    const panelBounds = await panel.boundingBox()
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width)
    const copy = await row.locator('.mlx-model-heading').evaluate((element) => {
      const name = element.children.item(0) as { scrollWidth: number; clientWidth: number } | null
      const purpose = element.children.item(1) as { scrollWidth: number; clientWidth: number } | null
      return {
        nameFits: name !== null && name.scrollWidth <= name.clientWidth,
        purposeFits: purpose !== null && purpose.scrollWidth <= purpose.clientWidth,
        purposeWraps: purpose !== null && element.ownerDocument.defaultView!.getComputedStyle(element.children.item(1)!).whiteSpace === 'normal',
      }
    })
    expect(copy.nameFits).toBe(true)
    expect(copy.purposeFits).toBe(true)
    expect(copy.purposeWraps).toBe(true)
  }
  const lightNarrowScreenshot = testInfo.outputPath('mlx-horizontal-rows-light-narrow.png')
  await page.screenshot({ path: lightNarrowScreenshot })
  await testInfo.attach('mlx-horizontal-rows-light-narrow', { path: lightNarrowScreenshot, contentType: 'image/png' })

})

test('resizes Recent and MLX sections from their top edges and restores height after collapse', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('folio:model-panel-collapsed', '0')
    localStorage.setItem('folio:recent-concepts-collapsed', 'false')
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Todo List', exact: true })).toBeVisible()
  const recentHeight = await dragPanelTop(page, 'Resize Recent concepts panel', '.recent-panel')
  await page.getByRole('button', { name: 'Collapse Recent concepts' }).click()
  const recent = page.locator('.recent-panel')
  expect((await recent.boundingBox())!.height).toBeLessThan(40)
  await page.getByRole('button', { name: 'Expand Recent concepts' }).click()
  expect(Math.abs((await recent.boundingBox())!.height - recentHeight)).toBeLessThanOrEqual(1)

  const mlxHeight = await dragPanelTop(page, 'Resize MLX panel', '.right-pane-status')
  await page.getByRole('button', { name: 'Collapse models' }).click()
  expect((await page.locator('.right-pane-status').boundingBox())!.height).toBeLessThan(40)
  await page.getByRole('button', { name: 'Expand models' }).click()
  expect(Math.abs((await page.locator('.right-pane-status').boundingBox())!.height - mlxHeight)).toBeLessThanOrEqual(1)
  const resizedScreenshot = testInfo.outputPath('recent-and-mlx-resized.png')
  await page.screenshot({ path: resizedScreenshot })
  await testInfo.attach('recent-and-mlx-resized', { path: resizedScreenshot, contentType: 'image/png' })
})
