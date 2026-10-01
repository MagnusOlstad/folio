import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'

test('refile flushes edits, discard preserves the note, and history restore keeps the new path', async ({ page, request }) => {
  const token = Date.now().toString(36)
  const title = `Refile E2E ${token}`
  const originalBody = `# ${title}\n\nOriginal text stays in the note.`
  const latestBody = `# ${title}\n\nLatest edited text is saved before review.`
  const created = await request.post('/api/file/create', { data: { directory: '/', name: title } })
  expect(created.status()).toBe(201)
  const createdId = (await created.json()).id as string
  let currentId = createdId
  try {
    const edited = await request.patch(`/api/note?id=${encodeURIComponent(createdId)}`, {
      data: { title, description: 'Original description.', tags: ['original'], content: originalBody, refreshEmbeddings: false },
    })
    expect(edited.ok(), await edited.text()).toBeTruthy()
    const checkpoint = await request.post('/api/note/history/checkpoint', { data: { id: createdId } })
    expect(checkpoint.ok()).toBeTruthy()

    const proposalsObserved: string[] = []
    await page.route('**/api/file/refile/propose', async route => {
      const body = route.request().postDataJSON() as { id: string }
      proposalsObserved.push(body.id)
      const latest = await request.get(`/api/file?path=${encodeURIComponent(body.id)}`)
      expect((await latest.json()).content).toContain('Latest edited text is saved before review.')
      const source = await request.get(`/api/concepts?path=${encodeURIComponent(body.id)}`)
      const markdown = await source.text()
      await route.fulfill({
        json: {
          id: body.id,
          hash: createHash('sha256').update(markdown).digest('hex'),
          proposal: {
            directory: `/refiled-e2e-${token}`,
            filename: `reviewed-${token}.md`,
            title: `Reviewed ${title}`,
            description: 'Reviewed description.',
            tags: ['reviewed', 'e2e'],
          },
        },
      })
    })

    await page.goto('/')
    await page.getByRole('button', { name: title, exact: true }).click()
    const editor = page.getByRole('textbox', { name: `Edit ${title}` })
    await editor.fill(latestBody)
    await page.getByRole('button', { name: 'Refile', exact: true }).click()
    await expect.poll(() => proposalsObserved.length).toBe(1)
    const dialog = page.getByRole('dialog', { name: 'Refile note' })
    await expect(dialog.getByRole('textbox', { name: 'Path' })).toHaveValue(`/refiled-e2e-${token}/reviewed-${token}.md`)
    await dialog.getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByRole('button', { name: 'Refile', exact: true })).toBeVisible()
    let current = await request.get(`/api/file?path=${encodeURIComponent(createdId)}`)
    expect((await current.json()).content).toContain('Latest edited text is saved before review.')
    expect(proposalsObserved).toEqual([createdId])

    await page.getByRole('button', { name: 'Refile', exact: true }).click()
    const acceptedDialog = page.getByRole('dialog', { name: 'Refile note' })
    await acceptedDialog.getByRole('button', { name: 'Accept and refile' }).click()
    currentId = `/refiled-e2e-${token}/reviewed-${token}.md`
    await expect(page.getByRole('button', { name: `Reviewed ${title}`, exact: true })).toBeVisible()
    current = await request.get(`/api/file?path=${encodeURIComponent(currentId)}`)
    const refiled = await current.json()
    expect(current.ok()).toBeTruthy()
    expect(refiled.content).toContain('Latest edited text is saved before review.')
    expect(refiled.description).toBe('Reviewed description.')
    expect(refiled.tags).toEqual(['reviewed', 'e2e'])
    expect(proposalsObserved).toEqual([createdId, createdId])

    const historyResponse = await request.get(`/api/note/history?id=${encodeURIComponent(currentId)}`)
    const history = await historyResponse.json()
    expect(history.entries.length).toBeGreaterThan(0)
    let originalRevision: string | null = null
    for (const entry of history.entries as { revision: string }[]) {
      const version = await request.get(`/api/note/history/version?id=${encodeURIComponent(currentId)}&revision=${encodeURIComponent(entry.revision)}`)
      const snapshot = await version.json()
      if (snapshot.note?.content?.includes('Original text stays in the note.')) {
        originalRevision = entry.revision
        break
      }
    }
    expect(originalRevision).toBeTruthy()
    const restore = await request.post('/api/note/history/restore', { data: { id: currentId, revision: originalRevision } })
    expect(restore.ok()).toBeTruthy()
    const restored = await restore.json()
    expect(restored.note.id).toBe(currentId)
    expect(restored.note.content).toContain('Original text stays in the note.')
    await expect(page.getByRole('button', { name: `Reviewed ${title}`, exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: title, exact: true }).click()
    await expect(page.locator('.document-heading').getByRole('button', { name: title, exact: true })).toBeVisible()
    await expect(page.getByText('Original text stays in the note.')).toBeVisible()
  } finally {
    await request.delete(`/api/note?id=${encodeURIComponent(currentId)}`)
  }
})
