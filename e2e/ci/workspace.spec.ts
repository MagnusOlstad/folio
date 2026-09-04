import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Keyboard-shortcut tests dispatch keys with no element to auto-wait on, so make
  // sure React has mounted and attached its window keydown listener first.
  await expect(page.getByRole('link', { name: 'Folio home' })).toBeVisible()
})

test('loads the workspace shell with the seeded bundle', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'Folio home' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'todo-list.md' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'start-here.md' })).toBeVisible()
})

test('reports Ollama as offline when no local model server is running', async ({ page }) => {
  await expect(page.getByText('Ollama offline')).toBeVisible()
})

test('opens a seeded note and shows its content', async ({ page }) => {
  await page.getByRole('button', { name: 'todo-list.md' }).click()
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
    await editor.selectText()
    await page.keyboard.press('Control+b')
    await expect(editor).toHaveValue('**hello**')
  })

  test('Cmd/Ctrl+I italicizes the selected text', async ({ page }) => {
    await page.keyboard.press('Control+t')
    const editor = page.getByLabel('Write a new note')
    await editor.fill('hello')
    await editor.selectText()
    await page.keyboard.press('Control+i')
    await expect(editor).toHaveValue('*hello*')
  })

  test('Cmd/Ctrl+K wraps the selected text as a Markdown link', async ({ page }) => {
    await page.keyboard.press('Control+t')
    const editor = page.getByLabel('Write a new note')
    await editor.fill('hello')
    await editor.selectText()
    await page.keyboard.press('Control+k')
    await expect(editor).toHaveValue('[hello]()')
  })

  test('Cmd/Ctrl+S files a new draft, degrading gracefully with Ollama offline', async ({ page }) => {
    await page.keyboard.press('Control+t')
    const editor = page.getByLabel('Write a new note')
    await editor.fill('note: quick capture via Ctrl+S')
    await page.keyboard.press('Control+s')
    await expect(page.getByRole('status')).toContainText('Ollama was unavailable')
  })
})
