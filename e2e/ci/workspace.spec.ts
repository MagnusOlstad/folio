import { expect, test } from '@playwright/test'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Keyboard-shortcut tests dispatch keys with no element to auto-wait on, so make
  // sure React has mounted and attached its window keydown listener first.
  await expect(page.getByRole('link', { name: 'Folio home' })).toBeVisible()
})

test('loads the workspace shell with the seeded bundle', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'Folio home' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Todo List', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Here', exact: true })).toBeVisible()
  await expect(page.getByText('todo-list.md')).toHaveCount(0)
})

test('reports Ollama as offline when no local model server is running', async ({ page }) => {
  await expect(page.getByText('Ollama offline')).toBeVisible()
})

test('changes and restores the color theme from browser settings', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('radio')).toHaveCount(4)
  await settings.getByText('Editorial', { exact: true }).click()
  await expect(settings.getByRole('radio', { name: /Editorial/ })).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'editorial')
  await settings.getByRole('button', { name: 'Close' }).click()

  await page.reload()

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'editorial')
})

test('downloads a bundle backup from settings', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download bundle backup' }).click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toMatch(/^folio-bundle-backup-.+\.zip$/)
  expect(await download.failure()).toBeNull()
  const stream = await download.createReadStream()
  expect(stream).not.toBeNull()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).subarray(0, 2)).toEqual(Buffer.from('PK'))
})

test('opens a seeded note and shows its content', async ({ page }) => {
  await page.getByRole('button', { name: 'Todo List', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Todo List', level: 1 }).first()).toBeVisible()
  await expect(page.getByText('Add your first task')).toBeVisible()
})

test('creates a new local draft note from the editor', async ({ page }) => {
  await page.getByTitle('New note (Cmd+T)').click()
  const editor = page.getByLabel('Write a new note')
  await editor.fill('My first draft note')

  await expect(page.locator('.draft-tree-open', { hasText: 'My first draft note' })).toBeVisible()
})

// Cmd/Ctrl+T, +S, +B, +I, +K, and +Shift+F are documented as working in both the
// browser and the desktop app (unlike +W, which browsers reserve and the app
// deliberately skips outside Electron - see src/App.tsx's close-tab guard).
test.describe('browser-safe keyboard shortcuts', () => {
  test('Cmd/Ctrl+T opens a new note tab', async ({ page }) => {
    const tabsBefore = await page.locator('.editor-tab').count()
    await page.keyboard.press('Control+t')
    await expect(page.locator('.editor-tab')).toHaveCount(tabsBefore + 1)
    await expect(page.getByLabel('Write a new note')).toBeVisible()
  })

  test('Cmd/Ctrl+Shift+F focuses the sidebar search field', async ({ page }) => {
    await page.keyboard.press('Control+Shift+F')
    await expect(page.getByLabel('Search your notes')).toBeFocused()
  })

  test('Cmd/Ctrl+B bolds the selected text', async ({ page }) => {
    await page.keyboard.press('Control+t')
    const editor = page.getByLabel('Write a new note')
    await editor.fill('hello')
    await editor.press(`${modifier}+a`)
    await page.keyboard.press(`${modifier}+b`)
    await expect(editor).toHaveText('**hello**')
  })

  test('Cmd/Ctrl+I italicizes the selected text', async ({ page }) => {
    await page.keyboard.press('Control+t')
    const editor = page.getByLabel('Write a new note')
    await editor.fill('hello')
    await editor.press(`${modifier}+a`)
    await page.keyboard.press(`${modifier}+i`)
    await expect(editor).toHaveText('*hello*')
  })

  test('Cmd/Ctrl+K wraps the selected text as a Markdown link', async ({ page }) => {
    await page.keyboard.press('Control+t')
    const editor = page.getByLabel('Write a new note')
    await editor.fill('hello')
    await editor.press(`${modifier}+a`)
    await page.keyboard.press(`${modifier}+k`)
    await expect(editor).toHaveText('[hello]()')
  })

  test('Cmd/Ctrl+S starts in-note filing and Enter accepts the proposal', async ({ page }) => {
    await page.keyboard.press('Control+t')
    const editor = page.getByLabel('Write a new note')
    await editor.fill('note: quick capture via Ctrl+S')
    await page.keyboard.press('Control+s')
    await expect(page.getByLabel('Filing confirmation')).toContainText('Review filing')
    await expect(page.getByLabel('Filing confirmation').getByLabel('Filename')).toHaveCount(0)
    await page.getByRole('button', { name: 'search', exact: true }).click()
    await expect(page.getByLabel('Filing confirmation')).toContainText('Review filing')
    await page.getByRole('button', { name: 'explore', exact: true }).click()
    const pathInput = page.getByRole('combobox', { name: 'Path' })
    await pathInput.fill('/getting-st')
    await pathInput.press('Tab')
    await expect(pathInput).toHaveValue('/getting-started')
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('Filing confirmation')).toHaveCount(0)

    await page.keyboard.press('Control+t')
    const dismissedEditor = page.getByLabel('Write a new note')
    await dismissedEditor.fill('note: keep the agent filing on Escape')
    await page.keyboard.press('Control+s')
    await expect(page.getByLabel('Filing confirmation')).toContainText('Review filing')
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('Filing confirmation')).toHaveCount(0)
  })
})
