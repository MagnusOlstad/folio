import { expect, test } from '@playwright/test'

const bundle = { 'x-folio-bundle': 'legacy-bundle' }

test('fake MLX helper drives entity extraction, scoped retrieval, corrections, and isolated settings', async ({ page, request }) => {
  const installed = await request.post('/api/mlx/models/gliner25multi/install', { headers: bundle })
  expect(installed.ok()).toBeTruthy()
  const enabled = await request.get('/api/entities/settings', { headers: bundle })
  expect(await enabled.json()).toMatchObject({ enabled: true, modelId: 'gliner25multi' })

  const queued = await request.post('/api/entities/jobs', {
    headers: bundle,
    data: { noteIds: ['/entity-launch.md', '/entity-followup.md'], force: true, reason: 'manual' },
  })
  expect(queued.status()).toBe(202)
  const job = await queued.json() as { id: string }
  await expect.poll(async () => {
    const response = await request.get(`/api/entities/jobs/${job.id}`, { headers: bundle })
    const result = await response.json() as { state: string }
    return result.state
  }, { timeout: 15_000 }).toBe('complete')

  const entityResponse = await request.get('/api/entities?activity=all', { headers: bundle })
  const entityPage = await entityResponse.json() as { items: Array<{ id: string; label: string; type: string }> }
  expect(entityPage.items.map((entity) => [entity.label, entity.type])).toEqual(expect.arrayContaining([
    ['Acme', 'organization'], ['Atlas', 'product'], ['Priya Sharma', 'person'],
  ]))
  const acme = entityPage.items.find((entity) => entity.label === 'Acme')!
  const atlas = entityPage.items.find((entity) => entity.label === 'Atlas')!

  const scopedSearch = await request.get(`/api/search?entityIds=${encodeURIComponent(`${acme.id},${atlas.id}`)}&includeScope=true`, { headers: bundle })
  expect(scopedSearch.ok()).toBeTruthy()
  const searchResult = await scopedSearch.json() as { items: Array<{ id: string }>; scope: { entityIds: string[]; matchedNoteCount: number } }
  expect(searchResult.scope.entityIds).toEqual([acme.id, atlas.id])
  expect(searchResult.scope.matchedNoteCount).toBe(2)
  expect(searchResult.items.map((item) => item.id)).toContain('/entity-launch.md')

  const generationInstall = await request.post('/api/mlx/models/gemma4/install', { headers: bundle })
  expect(generationInstall.ok()).toBeTruthy()
  const ask = await request.post('/api/ask', {
    headers: bundle,
    data: { question: 'What did Acme and Atlas share?', entityIds: [acme.id, atlas.id] },
  })
  expect(ask.ok()).toBeTruthy()
  const answer = await ask.json() as { sources: Array<{ id: string }>; scope: { entityIds: string[]; matchedNoteCount: number } }
  expect(answer.scope.entityIds).toEqual([acme.id, atlas.id])
  expect(answer.scope.matchedNoteCount).toBeGreaterThan(0)
  expect(answer.sources.length).toBeGreaterThan(0)
  expect(answer.sources.every((source) => searchResult.items.some((item) => item.id === source.id))).toBe(true)

  const latest = await (await request.get('/api/entities/corrections/latest', { headers: bundle })).json() as { revision: number }
  const rename = await request.post('/api/entities/corrections', {
    headers: bundle,
    data: { expectedRevision: latest.revision, command: { type: 'rename', entityId: acme.id, label: 'Acme Systems' } },
  })
  expect(rename.ok()).toBeTruthy()
  const rebuild = await request.post('/api/entities/jobs', { headers: bundle, data: { force: true, reason: 'rebuild' } })
  expect(rebuild.status()).toBe(202)
  await expect.poll(async () => {
    const result = await (await request.get('/api/entities?activity=all', { headers: bundle })).json() as { items: Array<{ label: string }> }
    return result.items.some((entity) => entity.label === 'Acme Systems')
  }, { timeout: 15_000 }).toBe(true)

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Acme launch', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Acme launch', exact: true }).click()
  await page.getByRole('tab', { name: 'Entities' }).click()
  const entities = page.getByRole('region', { name: 'Entities' })
  await expect(entities.getByRole('button', { name: 'Acme Systems' })).toBeVisible()
  const acmeMention = entities.getByRole('button', { name: 'Acme', exact: true }).first()
  await acmeMention.click()
  await expect(page.getByRole('textbox', { name: 'Edit Acme launch' })).toBeVisible()
  await expect(page.locator('.cm-editor .cm-content')).toContainText('Acme met Priya Sharma to review Atlas.')
  const editor = page.getByRole('textbox', { name: 'Edit Acme launch' })
  await editor.focus()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { getSelection: () => { toString: () => string } | null }).getSelection()?.toString() || '')).toBe('Acme')
  await editor.fill('Draft differs from the saved source.')
  await expect(entities.getByRole('button', { name: 'Acme', exact: true }).first()).toBeDisabled()

  const createdBundle = await request.post('/api/bundles/setup', { data: { name: `Entity isolation ${Date.now()}`, source: 'empty' } })
  expect(createdBundle.status()).toBe(201)
  const created = await createdBundle.json() as { bundle: { id: string } }
  const otherSettings = await (await request.get('/api/entities/settings', { headers: { 'x-folio-bundle': created.bundle.id } })).json()
  expect(otherSettings).toMatchObject({ enabled: false, modelId: 'gliner25multi' })
  expect(await (await request.get('/api/entities/settings', { headers: bundle })).json()).toMatchObject({ enabled: true })
})
