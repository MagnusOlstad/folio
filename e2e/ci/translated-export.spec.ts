import { expect, test, type Page } from '@playwright/test'

async function mockExport(page: Page, id: string) {
  let polls = 0
  await page.route('**/api/translation/settings', (route) => route.fulfill({ json: { enabled: false, available: true } }))
  await page.route('**/api/note/translation/export', (route) => route.fulfill({
    status: 202, json: { jobId: 'job-1', id, target: 'de', status: 'running', translatedBlocks: 0, totalBlocks: 2 },
  }))
  await page.route('**/api/note/translation/export/job-1', (route) => {
    polls += 1
    return route.fulfill({
      json: polls < 2
        ? { jobId: 'job-1', id, target: 'de', status: 'running', translatedBlocks: 1, totalBlocks: 2 }
        : { jobId: 'job-1', id, target: 'de', status: 'done', translatedBlocks: 2, totalBlocks: 2, title: 'Deutscher Titel', description: 'Beschreibung', content: 'Erster Absatz.\n\nZweiter Absatz.' },
    })
  })
}

test('translated export downloads a suffixed Markdown file and can open a new draft', async ({ page, request }) => {
  const title = `Export Translation E2E ${Date.now().toString(36)}`
  const created = await request.post('/api/file/create', { data: { directory: '/', name: title } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  try {
    await mockExport(page, id)
    await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
    await page.goto('/')
    await page.locator('.workbench-sidebar').getByRole('button', { name: title, exact: true }).click()
    const openDialog = async () => {
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Translate…' }).click()
      return page.getByRole('dialog', { name: 'Translate and export' })
    }

    let dialog = await openDialog()
    await dialog.getByRole('radio', { name: 'Deutsch' }).check()
    await dialog.getByRole('radio', { name: 'Markdown file' }).check()
    const download = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Translate' }).click()
    await expect(dialog.getByText('Translating 1 of 2 paragraphs…')).toBeVisible({ timeout: 5_000 })
    expect((await download).suggestedFilename()).toBe(`${title}.de.md`)
    await expect(dialog).toHaveCount(0)

    dialog = await openDialog()
    await expect(dialog.getByRole('radio', { name: 'Deutsch' })).toBeChecked()
    await dialog.getByRole('radio', { name: 'New draft' }).check()
    await dialog.getByRole('button', { name: 'Translate' }).click()
    await expect(page.getByText('Zweiter Absatz.')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('textbox', { name: 'Filing guidance' })).toHaveValue('')
    await expect(page.getByLabel('Write a new note')).toContainText('# Deutscher Titel')
  } finally {
    await request.delete(`/api/note?id=${encodeURIComponent(id)}`)
  }
})
