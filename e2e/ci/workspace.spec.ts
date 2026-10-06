import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title !== 'first-open model setup opens the real model settings controls') {
    await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
  }
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

test('opens a path-directed draft from a bundle directory context menu', async ({ page, request }) => {
  const token = Date.now().toString(36)
  const folderName = `e2e-${token}`
  const title = `Explorer note ${token}`
  let createdId: string | null = null

  try {
    const bundleHeading = page.locator('.bundle-explorer-heading.active')
    await bundleHeading.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
    await page.getByRole('textbox', { name: 'New folder' }).fill(folderName)
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    const folder = page.locator('.tree-directory').filter({ hasText: folderName })
    await expect(folder).toBeVisible()
    await folder.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New note', exact: true }).click()
    await expect(folder).toHaveAttribute('aria-expanded', 'true')
    const editor = page.getByRole('textbox', { name: 'Write a new note' })
    await expect(page.getByRole('textbox', { name: 'Filing guidance' })).toHaveValue(`path: /${folderName}`)
    await editor.fill(`${title}\nA note created through ordinary filing.`)
    const filingResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/notes',
    )
    await page.getByRole('button', { name: 'File note' }).click()
    const created = await filingResponse
    expect(created.status()).toBe(201)
    const createdResult = await created.json() as { note: { id: string } }
    createdId = createdResult.note.id

    const confirmationResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/filing/confirm',
    )
    await page.getByRole('dialog', { name: 'Filing confirmation' }).getByRole('button', { name: 'Accept' }).click()
    const confirmed = await confirmationResponse
    expect(confirmed.ok()).toBeTruthy()
    const confirmationResult = await confirmed.json() as { note: { id: string }; newId: string }
    expect(confirmationResult.newId).toBe(confirmationResult.note.id)
    expect(confirmationResult.newId).toMatch(new RegExp(`^/${folderName}/`))
    createdId = confirmationResult.newId
    await expect(page.getByRole('dialog', { name: 'Filing confirmation' })).toHaveCount(0)

    const files = await request.get('/api/files')
    const createdFile = (await files.json()).find((file: { id: string }) => file.id.startsWith(`/${folderName}/`))
    expect(createdFile).toBeTruthy()
    expect(createdFile.id).toBe(createdId)
    if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click()
    await expect(page.locator('button.tree-file[aria-label]').filter({ hasText: title })).toBeVisible()
    const createdDocument = await request.get(`/api/file?path=${encodeURIComponent(createdId!)}`)
    expect(createdDocument.ok()).toBeTruthy()
    const document = await createdDocument.json()
    expect(document.content).toContain('A note created through ordinary filing.')
  } finally {
    if (createdId) await request.delete(`/api/note?id=${encodeURIComponent(createdId)}`)
  }
})

test('deletes only empty folders from the explorer context menu', async ({ page, request }) => {
  const token = Date.now().toString(36)
  const emptyFolderName = `empty-${token}`
  const nonemptyFolderName = `kept-${token}`
  let nonemptyFileId: string | null = null

  try {
    const bundleHeading = page.locator('.bundle-explorer-heading.active')
    await bundleHeading.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
    await page.getByRole('textbox', { name: 'New folder' }).fill(emptyFolderName)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const emptyFolder = page.locator('.tree-directory').filter({ hasText: emptyFolderName })
    await expect(emptyFolder).toBeVisible()
    await emptyFolder.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const emptyDeleteDialog = page.getByRole('dialog', { name: 'Confirm delete' })
    await expect(emptyDeleteDialog).toContainText(`Delete ${emptyFolderName}?`)
    await expect(emptyDeleteDialog).toContainText('Only an empty folder can be deleted')
    await emptyDeleteDialog.getByRole('button', { name: 'Delete' }).click()
    await expect(emptyFolder).toHaveCount(0)

    await bundleHeading.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
    await page.getByRole('textbox', { name: 'New folder' }).fill(nonemptyFolderName)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const nonemptyFolder = page.locator('.tree-directory').filter({ hasText: nonemptyFolderName })
    await expect(nonemptyFolder).toBeVisible()
    const createFileResponse = await request.post('/api/file/create', {
      data: { directory: `/${nonemptyFolderName}`, name: 'keep.md' },
    })
    expect(createFileResponse.ok()).toBeTruthy()
    nonemptyFileId = (await createFileResponse.json()).id
    await page.reload()
    await expect(page.getByRole('button', { name: 'Todo List', exact: true })).toBeVisible()
    const reloadedNonemptyFolder = page.locator('.tree-directory').filter({ hasText: nonemptyFolderName })
    await expect(reloadedNonemptyFolder).toBeVisible()
    await reloadedNonemptyFolder.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const nonemptyDeleteDialog = page.getByRole('dialog', { name: 'Confirm delete' })
    await nonemptyDeleteDialog.getByRole('button', { name: 'Delete' }).click()
    await expect(page.locator('.workspace-message')).toContainText('Only an empty folder can be deleted.')
    await expect(reloadedNonemptyFolder).toBeVisible()
  } finally {
    if (nonemptyFileId) await request.delete(`/api/note?id=${encodeURIComponent(nonemptyFileId)}`)
    await request.delete(`/api/file/folder?path=${encodeURIComponent(`/${emptyFolderName}`)}`).catch(() => {})
    await request.delete(`/api/file/folder?path=${encodeURIComponent(`/${nonemptyFolderName}`)}`).catch(() => {})
  }
})

test('shows controls for all six supported local models', async ({ page }) => {
  const models = page.getByRole('region', { name: 'MLX model management' })
  await expect(models).toBeVisible()
  await expect(models.getByText(/Gemma 4/)).toBeVisible()
  await expect(models.getByText(/Qwen 3.5/)).toBeVisible()
  await expect(models.getByText(/Llama 3.2/)).toBeVisible()
  await expect(models.getByText('EmbeddingGemma', { exact: true })).toBeVisible()
  await expect(models.getByRole('button', { name: /Whisper Large v3 Turbo/ })).toBeVisible()
  await expect(models.getByRole('button', { name: /Whisper Large v3$/ })).toBeVisible()
  await expect(models.locator('.mlx-model')).toHaveCount(6)
})

test('first-open model setup opens the real model settings controls', async ({ page }) => {
  const setup = page.getByRole('region', { name: 'MLX model management' })
  await expect(setup.getByRole('button', { name: 'Open model settings' })).toBeVisible()
  await setup.getByRole('button', { name: 'Open model settings' }).click()

  const settings = page.getByRole('dialog', { name: 'Settings' })
  const models = settings.getByRole('region', { name: 'Local models' })
  await expect(models.getByRole('radio', { name: /Qwen 3\.5 4B/ })).toBeVisible()
  await expect(models.getByRole('radio', { name: /Llama 3\.2 3B Instruct/ })).toBeVisible()
  await expect(models.getByRole('radio', { name: /Gemma 4/ })).toBeVisible()
  await expect(models.getByRole('radio', { name: /Whisper Large v3 Turbo/ })).toBeVisible()
  await expect(models.getByRole('radio', { name: /Whisper Large v3.*3\.1 GB/ })).toBeVisible()
  await expect(models.getByText('EmbeddingGemma', { exact: true })).toBeVisible()
  await expect(models.getByRole('radio', { name: /EmbeddingGemma/ })).toHaveCount(0)
  await expect(models.getByRole('button', { name: 'Download' }).first()).toBeDisabled()
  await expect(models.getByText(/Local MLX models need Apple Silicon and macOS 14 or newer|local MLX helper is not ready/i)).toBeVisible()
})

test('changes and restores the color theme from browser settings', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance' }).click()
  await expect(settings.getByRole('radio')).toHaveCount(4)
  await settings.getByText('Editorial', { exact: true }).click()
  await expect(settings.getByRole('radio', { name: /Editorial/ })).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'editorial')
  await settings.getByRole('button', { name: 'Close' }).click()

  await page.reload()

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'editorial')
})

test('persists note font size across rendered notes, editors, and reloads', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Edit Start Here' })
  await expect(editor).toBeVisible()
  const editorContent = page.locator('.live-markdown-editor .cm-content').first()
  await expect.poll(() => editorContent.evaluate(element => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize)).toBe('18px')
  await page.getByRole('button', { name: 'index.md', exact: true }).click()
  await expect(page.locator('[data-readonly-markdown]')).toBeVisible()
  const viewer = page.locator('.document-content').first()
  await expect.poll(() => viewer.evaluate(element => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize)).toBe('18px')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance' }).click()
  const slider = settings.getByRole('slider', { name: 'Note font size' })
  await slider.focus()
  for (let step = 0; step < 6; step += 1) await slider.press('ArrowRight')
  await expect(settings.locator('.note-font-size-control output')).toHaveText('24px')
  await expect.poll(() => viewer.evaluate(element => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize)).toBe('24px')
  await page.screenshot({ path: testInfo.outputPath('appearance-settings.png') })
  await settings.getByRole('button', { name: 'Close' }).click()

  await page.reload()
  await expect(page.locator('html')).toHaveCSS('--note-font-size', '24px')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  await expect.poll(() => page.locator('.live-markdown-editor .cm-content').first().evaluate(element => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize)).toBe('24px')
  await page.getByTitle('New note (Cmd+T)').click()
  await expect.poll(() => page.locator('.draft-note-editor .cm-content').first().evaluate(element => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize)).toBe('24px')
})

test('collapses Recent concepts and restores the saved state after reload', async ({ page }) => {
  const disclosure = page.getByRole('button', { name: /Recent concepts/ })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#recent-concepts-list')).toBeHidden()

  await page.reload()
  await expect(page.getByRole('button', { name: /Recent concepts/ })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#recent-concepts-list')).toBeHidden()
})

test('reindexes the active bundle from settings', async ({ page }) => {
  const activeBundleId = await page.evaluate(() => localStorage.getItem('folio:bundle-active:v1'))
  expect(activeBundleId).toBeTruthy()
  await expect(page.locator('.sidebar-heading').filter({ hasText: 'Explorer' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reindex', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const responsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/reindex',
  )
  await settings.getByRole('button', { name: 'Reindex active bundle' }).click()
  const response = await responsePromise
  expect(response.ok()).toBeTruthy()
  expect(response.request().headers()['x-folio-bundle-id']).toBe(activeBundleId)
})

test('keeps the settings category sidebar stationary while model content scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Models' }).click()
  const nav = settings.getByRole('navigation', { name: 'Settings categories' })
  const content = settings.locator('.settings-content')
  const before = await nav.boundingBox()
  const overflow = await content.evaluate((element) => element.scrollHeight > element.clientHeight)
  expect(overflow).toBe(true)
  await content.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await nav.boundingBox()).toEqual(before)
  await expect(nav.getByRole('button', { name: 'Models' })).toBeVisible()
})

test('keeps every settings category inside a fixed-height dialog on wide and short narrow screens', async ({ page }) => {
  const viewports = [{ width: 1280, height: 420 }, { width: 360, height: 360 }]
  for (const [index, viewport] of viewports.entries()) {
    if (index > 0) {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
    } else {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
    }
    await page.setViewportSize(viewport)
    const settings = page.getByRole('dialog', { name: 'Settings' })
    const nav = settings.getByRole('navigation', { name: 'Settings categories' })
    const content = settings.locator('.settings-content')
    const dialogBounds = await settings.boundingBox()
    expect(dialogBounds).not.toBeNull()
    expect(dialogBounds!.y).toBeGreaterThanOrEqual(0)
    expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(viewport.height)

    for (const [category, panel] of [
      ['Bundles', 'bundles'],
      ['Models', 'models'],
      ['Appearance', 'appearance'],
      ['Backup', 'backup'],
      ['Updates', 'updates'],
    ]) {
      await nav.getByRole('button', { name: category, exact: true }).click()
      await expect(settings.locator(`#settings-panel-${panel}`)).toBeVisible()
      const nextBounds = await settings.boundingBox()
      expect(nextBounds?.height).toBeCloseTo(dialogBounds!.height, 0)
      expect(await content.evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).overflowY)).toBe('auto')
      const navBounds = await nav.boundingBox()
      expect(navBounds).not.toBeNull()
      expect(navBounds!.y).toBeGreaterThanOrEqual(dialogBounds!.y)
      expect(navBounds!.y + navBounds!.height).toBeLessThanOrEqual(dialogBounds!.y + dialogBounds!.height)
    }
    await settings.getByRole('button', { name: 'Close' }).click()
  }
})

test('downloads all attached bundle backups from settings', async ({ page }) => {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settings.getByRole('button', { name: 'Backup' }).click()
  const downloadPromise = page.waitForEvent('download')
  await settings.getByRole('link', { name: 'Download all bundle backups' }).click()
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
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const noteEditor = page.getByRole('textbox', { name: 'Edit Start Here' })
  await noteEditor.fill('# Start Here\n\nEdited before creating another bundle')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Create bundle or import Obsidian vault' }).click()
  await settings.getByRole('textbox', { name: 'Name' }).fill(bundleName)
  const checkpoint = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/checkpoint') && response.request().method() === 'POST'
  })
  await settings.getByRole('button', { name: 'Create bundle' }).click()
  expect((await checkpoint).ok()).toBeTruthy()
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

test('shows the indexed last-edited date after a search result title', async ({ page, request }) => {
  const title = `Search Date Regression ${Date.now().toString(36)}`
  let createdId: string | null = null

  try {
    const createResponse = await request.post('/api/file/create', { data: { directory: '/', name: `${title}.md` } })
    expect(createResponse.status()).toBe(201)
    const created = await createResponse.json() as { id: string }
    createdId = created.id

    const searchResponse = await request.get(`/api/search?q=${encodeURIComponent(title)}`)
    expect(searchResponse.ok()).toBeTruthy()
    const searchResults = await searchResponse.json()
    const searchResult = searchResults.find((result: { id: string }) => result.id === createdId)
    expect(Number.isNaN(Date.parse(searchResult?.updatedAt))).toBe(false)

    await page.getByRole('button', { name: 'search', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search your notes' }).fill(title)
    await page.getByRole('button', { name: 'Go', exact: true }).click()

    const result = page.locator('.sidebar-result').filter({ hasText: title })
    const date = result.locator('time')
    await expect(date).toBeVisible()
    await expect(date).toHaveAttribute('datetime', searchResult.updatedAt)
    const formattedDate = await page.evaluate((value: string) => new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    }).format(new Date(value)), searchResult.updatedAt)
    await expect(date).toHaveText(formattedDate)
  } finally {
    if (createdId) {
      const cleanupResponse = await request.delete(`/api/note?id=${encodeURIComponent(createdId)}`)
      expect(cleanupResponse.ok()).toBeTruthy()
    }
  }
})

test('creates a new local draft note from the editor', async ({ page }) => {
  await page.getByTitle('New note (Cmd+T)').click()
  const editor = page.getByLabel('Write a new note')
  await editor.fill('My first draft note')

  await expect(page.locator('.draft-tree-open', { hasText: 'My first draft note' })).toBeVisible()
})

test('keeps filing guidance separate from the note body and files the full pasted note', async ({ page, request }, testInfo) => {
  let createdId: string | null = null
  try {
    await page.getByTitle('New note (Cmd+T)').click()
    const editor = page.getByLabel('Write a new note')
    const body = 'Body starts here\nSecond body line'
    await editor.fill(body)

    const guidance = page.getByRole('textbox', { name: 'Filing guidance' })
    await guidance.fill('Project ')
    await guidance.pressSequentially('notes')
    await expect(guidance).toHaveValue('Project notes')
    await guidance.press('Escape')
    await expect(editor).toBeFocused()

    await expect(editor).toContainText('Body starts here')
    await expect(editor).toContainText('Second body line')
    await page.screenshot({ path: testInfo.outputPath('draft-guidance.png') })

    await expect.poll(async () => {
      const drafts = await (await request.get('/api/drafts')).json() as Array<{ content: string }>
      return drafts.some((draft) => draft.content === `Project notes\n${body}`)
    }).toBeTruthy()

    const filingRequest = page.waitForRequest((request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/notes',
    )
    const filingResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/notes',
    )
    await page.getByRole('button', { name: 'File note' }).click()
    const [requestPayload, response] = await Promise.all([filingRequest, filingResponse])
    expect(requestPayload.postDataJSON().filedContent).toBe(body)
    expect(response.status()).toBe(201)
    const result = await response.json() as { note: { id: string } }
    createdId = result.note.id

    const confirmationResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/filing/confirm',
    )
    await page.getByRole('dialog', { name: 'Filing confirmation' }).getByRole('button', { name: 'Accept' }).click()
    const confirmed = await confirmationResponse
    expect(confirmed.ok()).toBeTruthy()
    const confirmationResult = await confirmed.json() as { note: { id: string; content: string }; newId: string }
    expect(confirmationResult.newId).toBe(confirmationResult.note.id)
    createdId = confirmationResult.newId

    const filedNote = await request.get(`/api/note?id=${encodeURIComponent(createdId)}`)
    expect(filedNote.ok()).toBeTruthy()
    const filedResult = await filedNote.json() as { content: string }
    expect(filedResult.content).toContain('Body starts here')
    expect(filedResult.content).toContain('Second body line')
  } finally {
    if (createdId) {
      const cleanupResponse = await request.delete(`/api/note?id=${encodeURIComponent(createdId)}`)
      expect(cleanupResponse.ok()).toBeTruthy()
    }
  }
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

  test('Cmd/Ctrl+S starts in-note filing and Enter accepts the proposal', async ({ page, request }) => {
    const token = Date.now().toString(36)
    try {
      await page.keyboard.press('Control+t')
      const editor = page.getByLabel('Write a new note')
      await editor.fill(`note: quick capture via Ctrl+S ${token}`)
      await page.keyboard.press('Control+s')
      const confirmation = page.getByLabel('Filing confirmation')
      await expect(confirmation).toContainText('Review filing')
      await expect(confirmation.getByLabel('Filename')).toHaveCount(0)
      await page.getByRole('button', { name: 'search', exact: true }).click()
      await expect(confirmation).toContainText('Review filing')
      await page.getByRole('button', { name: 'explore', exact: true }).click()
      const pathInput = page.getByRole('combobox', { name: 'Path' })
      await pathInput.fill('/getting-st')
      await pathInput.press('Tab')
      await expect(pathInput).toHaveValue('/getting-started')
      await expect(pathInput).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(confirmation).toHaveCount(0)

      await page.keyboard.press('Control+t')
      const dismissedEditor = page.getByLabel('Write a new note')
      await dismissedEditor.fill(`note: keep the agent filing on Escape ${token}`)
      await page.keyboard.press('Control+s')
      const escapeConfirmation = page.getByLabel('Filing confirmation')
      await expect(escapeConfirmation).toContainText('Review filing')
      await expect(escapeConfirmation.getByRole('button', { name: 'Accept' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(escapeConfirmation).toHaveCount(0)
    } finally {
      const filesResponse = await request.get('/api/files')
      if (filesResponse.ok()) {
        const files = await filesResponse.json() as { id: string; name: string }[]
        await Promise.all(files.filter((file) => file.name.includes(token)).map((file) =>
          request.delete(`/api/note?id=${encodeURIComponent(file.id)}`),
        ))
      }
    }
  })
})
