import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Keyboard-shortcut tests dispatch keys with no element to auto-wait on, so make
  // sure React has mounted and attached its window keydown listener first.
  await expect(page.getByRole('link', { name: 'Folio home' })).toBeVisible()
  // The logo only proves the shell mounted. Wait for registry resolution and the
  // active bundle tree before dispatching shortcuts or interacting with workspace state.
  await expect(page.getByRole('button', { name: 'Todo List', exact: true })).toBeVisible()
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

test('downloads all attached bundle backups from settings', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download all bundle backups' }).click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toMatch(/^folio-bundle-backup-.+\.zip$/)
  expect(await download.failure()).toBeNull()
  const stream = await download.createReadStream()
  expect(stream).not.toBeNull()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).subarray(0, 2)).toEqual(Buffer.from('PK'))
})

test('keeps a new bundle draft isolated across legacy bundle switches', async ({ page }) => {
  const bundleName = `E2E isolation ${Date.now()}`
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Create bundle or import Obsidian vault' }).click()
  await settings.getByRole('textbox', { name: 'Name' }).fill(bundleName)
  await settings.getByRole('button', { name: 'Create bundle' }).click()
  await expect(settings.getByRole('listitem').filter({ hasText: bundleName })).toBeVisible()
  await settings.getByRole('button', { name: 'Close' }).click()

  await page.getByTitle('New note (Cmd+T)').click()
  const editor = page.getByLabel('Write a new note')
  const draftContent = `${bundleName} draft`
  await editor.fill(draftContent)
  await expect(page.locator('.draft-tree-open', { hasText: draftContent })).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  const legacyRow = page.getByRole('listitem').filter({ hasText: 'Folio bundle' })
  await legacyRow.locator('.bundle-select').click()
  await expect(page.getByRole('button', { name: 'Todo List', exact: true })).toBeVisible()
  await expect(page.locator('.draft-tree-open', { hasText: draftContent })).toHaveCount(0)

  const legacySettings = page.getByRole('dialog', { name: 'Settings' })
  await legacySettings.getByRole('listitem').filter({ hasText: bundleName }).locator('.bundle-select').click()
  await expect(page.locator('.draft-tree-open', { hasText: draftContent })).toBeVisible()
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

test('exports the current draft as an exact Markdown download', async ({ page }) => {
  await page.getByTitle('New note (Cmd+T)').click()
  const editor = page.getByLabel('Write a new note')
  const content = 'Exported draft\n\n**Bold detail**'
  await editor.fill(content)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Markdown' }).click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toBe('Exported draft.md')
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  expect(await fs.readFile(downloadPath!, 'utf8')).toBe(content)
})

test('opens sidebar notes as a replaceable preview until the editor is focused', async ({ page }) => {
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const tabs = page.locator('.editor-tab')
  const startHereTab = tabs.filter({ hasText: 'Start Here' })
  await expect(tabs).toHaveCount(1)
  await expect(startHereTab).toHaveClass(/preview/)

  await page.getByRole('button', { name: 'Todo List', exact: true }).click()
  const todoTab = tabs.filter({ hasText: 'Todo List' })
  await expect(tabs).toHaveCount(1)
  await expect(todoTab).toHaveCount(1)
  await expect(todoTab).toHaveClass(/preview/)
  await expect(tabs.filter({ hasText: 'Start Here' })).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Edit Todo List' }).click()
  await expect(todoTab).not.toHaveClass(/preview/)
})

test('marks the prospective right-strip tab slot and reorders tabs within a group', async ({ page }) => {
  await page.getByRole('button', { name: 'Start Here', exact: true }).dblclick()
  await page.getByRole('button', { name: 'Todo List', exact: true }).dblclick()

  const startHereTab = page.locator('.editor-tab').filter({ hasText: 'Start Here' })
  const todoTab = page.locator('.editor-tab').filter({ hasText: 'Todo List' })
  const startBox = await startHereTab.boundingBox()
  const todoBox = await todoTab.boundingBox()
  const tabStripBox = await page.locator('.tab-strip').boundingBox()
  expect(startBox).not.toBeNull()
  expect(todoBox).not.toBeNull()
  expect(tabStripBox).not.toBeNull()

  await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    Math.min(todoBox!.x + todoBox!.width + 8, tabStripBox!.x + tabStripBox!.width - 4),
    todoBox!.y + todoBox!.height / 2,
    { steps: 8 },
  )
  await expect(todoTab).toHaveClass(/drop-after/)
  await page.mouse.up()

  await expect(todoTab).not.toHaveClass(/drop-after/)
  expect(await page.locator('.editor-tab').evaluateAll((tabs) =>
    tabs.map((tab) => tab.getAttribute('title')),
  )).toEqual(['Todo List', 'Start Here'])
})

test('tab selection preserves each local draft cursor for mouse and Cmd/Ctrl+number', async ({ page }) => {
  await page.getByTitle('New note (Cmd+T)').click()
  const firstEditor = page.getByLabel('Write a new note')
  await firstEditor.fill('First local draft')
  await firstEditor.press('Home')
  await firstEditor.press('ArrowRight')

  await page.getByTitle('New note (Cmd+T)').click()
  const secondEditor = page.getByLabel('Write a new note')
  await secondEditor.fill('Second local draft')
  await secondEditor.press('Home')
  for (let offset = 0; offset < 7; offset += 1) {
    await secondEditor.press('ArrowRight')
  }

  await page.locator('.editor-tab').filter({ hasText: 'First local draft' }).click()
  await expect(firstEditor).toBeFocused()
  await page.keyboard.type('X')
  await expect(firstEditor).toHaveText('FXirst local draft')

  await page.keyboard.press(`${modifier}+2`)
  await expect(secondEditor).toBeFocused()
  await page.keyboard.type('Y')
  await expect(secondEditor).toHaveText('Second Ylocal draft')
  await expect(page.locator('.editor-tab').filter({ hasText: 'Second Ylocal draft' })).toHaveClass(/active/)
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
