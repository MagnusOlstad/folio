import { expect, test, type Page } from '@playwright/test'

async function mockTranslation(page: Page, id: () => string, initiallyEnabled = true) {
  const requests: string[] = []
  let enabled = initiallyEnabled
  let polls = 0
  await page.route('**/api/translation/settings', (route) => {
    if (route.request().method() === 'PUT') enabled = (route.request().postDataJSON() as { enabled: boolean }).enabled
    return route.fulfill({ json: { enabled, available: true } })
  })
  await page.route('**/api/note/translation/prioritize', (route) => route.fulfill({ status: 202, json: { queued: true } }))
  await page.route('**/api/note/translation?**', (route) => {
    const url = new URL(route.request().url())
    requests.push(`${url.searchParams.get('id')}|${url.searchParams.get('target')}`)
    polls += 1
    const ready = polls > 1
    return route.fulfill({
      json: {
        id: id(), target: url.searchParams.get('target'), status: ready ? 'ready' : 'pending',
        translatedBlocks: ready ? 2 : 1, totalBlocks: 2, title: 'Translated title', description: 'Translated description',
        content: ready ? 'Translated paragraph one.\n\nTranslated paragraph two.' : 'Translated paragraph one.\n\nOriginal paragraph two.',
      },
    })
  })
  return requests
}

test('translated view shows pending then ready content and the choice survives a reload', async ({ page, request }) => {
  const title = `Translation E2E ${Date.now().toString(36)}`
  const created = await request.post('/api/file/create', { data: { directory: '/', name: title } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  try {
    const edited = await request.patch(`/api/note?id=${encodeURIComponent(id)}`, {
      data: { title, description: 'Beskrivelse', tags: [], content: `# ${title}\n\nFørste avsnitt.\n\nAndre avsnitt.`, refreshEmbeddings: false },
    })
    expect(edited.ok(), await edited.text()).toBeTruthy()
    const requests = await mockTranslation(page, () => id)
    await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
    await page.goto('/')
    await page.locator('.workbench-sidebar').getByRole('button', { name: title, exact: true }).click()
    const toggle = page.getByRole('radiogroup', { name: 'Note language' })
    await expect(toggle).toBeVisible()
    await toggle.getByRole('radio', { name: 'English' }).click()
    await expect(page.getByText('Translating 1 of 2 paragraphs…')).toBeVisible()
    await expect(page.getByText('Translated paragraph two.')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Translating \d of \d/)).toHaveCount(0)
    await expect(page.locator('.document-view [data-live-markdown-editor]')).toHaveCount(0)
    expect(requests.every((entry) => entry === `${id}|en`)).toBe(true)

    await page.reload()
    await expect(page.getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('Translated paragraph two.')).toBeVisible()

    await page.getByRole('radio', { name: 'Original' }).click()
    await expect(page.locator('.document-view [data-live-markdown-editor]')).toHaveCount(1)
  } finally {
    await request.delete(`/api/note?id=${encodeURIComponent(id)}`)
  }
})

test('switch off leaves only the switch, and turning it on restores the stored language', async ({ page, request }) => {
  const title = `Translation switch E2E ${Date.now().toString(36)}`
  const created = await request.post('/api/file/create', { data: { directory: '/', name: title } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  try {
    await mockTranslation(page, () => id, false)
    await page.addInitScript(([key, value]) => {
      localStorage.setItem('folio:model-setup-prompt-seen', '1')
      localStorage.setItem(key, value)
    }, ['folio:note-translation:v1:legacy-bundle', JSON.stringify({ [id]: 'no' })])
    await page.goto('/')
    await page.locator('.workbench-sidebar').getByRole('button', { name: title, exact: true }).click()
    const toggle = page.getByRole('switch', { name: 'Background translation' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('radiogroup', { name: 'Note language' })).toHaveCount(0)
    await expect(page.locator('.document-view [data-live-markdown-editor]')).toHaveCount(1)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('radio', { name: 'Norsk' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('Translated paragraph one.')).toBeVisible()
  } finally {
    await request.delete(`/api/note?id=${encodeURIComponent(id)}`)
  }
})

test('local drafts show no language toggle and never request translations', async ({ page }) => {
  const requests = await mockTranslation(page, () => 'untitled')
  await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'FolioNotes home' })).toBeVisible()
  await page.getByTitle('New note (Cmd+T)').click()
  await expect(page.getByRole('button', { name: 'Close Untitled', exact: true })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Note language' })).toHaveCount(0)
  expect(requests).toEqual([])
})
