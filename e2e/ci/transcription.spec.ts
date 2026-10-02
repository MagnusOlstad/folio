import { expect, test } from '@playwright/test'

test('imports audio, downloads local Whisper, files an editable note, and summarizes its edits', async ({ page, request }) => {
  let installed = false
  let summarizedTranscript = ''
  let filedNoteId = ''
  let sourceBundleId = ''
  const processedSessionIds = new Set<string>()
  const rawResults = new Map<string, { summary: string; transcript: string }>()
  await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname !== '/api/notes' || response.request().method() !== 'POST') return
    const payload = await response.json()
    filedNoteId = payload.note?.id || ''
  })
  await page.route('**/api/transcriptions/status', (route) => route.fulfill({ json: {
    model: 'mlx-community/whisper-large-v3-turbo', revision: 'test-revision',
    available: true, helperAvailable: true, modelState: installed ? 'ready' : 'missing',
    downloadedBytes: installed ? 1_610_000_000 : 0, totalBytes: 1_610_000_000,
    downloadPercent: installed ? 100 : 0, canInstall: true, canTranscribe: installed, installing: false,
  } }))
  await page.route('**/api/transcriptions/model/install', async (route) => {
    installed = true
    await route.fulfill({ json: { modelState: 'ready', canTranscribe: true } })
  })
  await page.route('**/api/transcriptions?pending=1', async (route) => {
    const upstream = await route.fetch()
    const sessions = await upstream.json()
    await route.fulfill({ json: sessions.map((session: { id: string; state: string }) => session.state === 'recorded' && processedSessionIds.has(session.id) ? { ...session, state: 'ready' } : session) })
  })
  await page.route('**/api/transcriptions/*/process', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)
    if (id) processedSessionIds.add(id)
    const result = { summary: '', transcript: 'The project review is next Tuesday at noon.' }
    if (id) rawResults.set(id, result)
    const sessionResponse = await request.get(`/api/transcriptions/${id}`)
    const { session } = await sessionResponse.json()
    sourceBundleId = session.sourceBundleId
    await route.fulfill({ json: { session: { ...session, state: 'ready' }, result } })
  })
  await page.route('**/api/transcriptions/*/summarize', async (route) => {
    summarizedTranscript = JSON.parse(route.request().postData() || '{}').transcript
    await route.fulfill({ json: { result: {
      summary: '- The project review is Wednesday at noon.',
      transcript: summarizedTranscript,
    } } })
  })
  await page.route('**/api/transcriptions/*', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || url.pathname.endsWith('/status') || url.pathname.endsWith('/process')) {
      await route.fallback()
      return
    }
    const id = url.pathname.split('/').at(-1) || ''
    const raw = rawResults.get(id)
    if (!raw) { await route.fallback(); return }
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), result: raw } })
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Todo List', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await expect(page.getByText(/Download mlx-community\/whisper-large-v3-turbo/)).toBeVisible()
  await page.getByRole('button', { name: 'Download model' }).click()
  await expect(page.getByText('Whisper is ready', { exact: true })).toBeVisible()

  await page.getByLabel('Choose local audio file').setInputFiles({
    name: 'project-review.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFF-local-audio-fixture'),
  })
  const imported = page.locator('.transcription-item').filter({ hasText: 'project-review.wav' })
  await expect(imported).toBeVisible()
  await imported.getByRole('button', { name: 'Transcribe' }).first().click()
  const draftEditor = page.getByLabel('Write a new note')
  await expect(draftEditor).toBeVisible()
  await expect(draftEditor).toContainText('Source audio: project-review.wav')
  const transcriptNote = '# project-review transcript\n\n- Source audio: project-review.wav\n- Imported: today\n- Duration: Unknown\n- Source note: Not linked to a source note\n\n## Summary\n\nGenerate a summary from this transcript.\n\n## Transcript\n\nCorrected: the project review is Wednesday at noon.\n'
  await draftEditor.fill(transcriptNote)
  await page.getByRole('button', { name: 'File note' }).click()
  const confirmation = page.getByRole('dialog', { name: 'Filing confirmation' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Accept' }).click()
  await expect.poll(() => filedNoteId).toMatch(/^(?!untitled:).+/)
  const filedNoteResponse = await request.get(`/api/note?id=${encodeURIComponent(filedNoteId)}`, {
    headers: { 'x-folio-bundle': sourceBundleId },
  })
  const filedNoteBeforeSummary = (await filedNoteResponse.json()).content

  await page.getByRole('tab', { name: 'Transcription' }).click()
  const filed = page.locator('.transcription-item').filter({ hasText: 'project-review.wav' })
  await filed.getByRole('button', { name: 'Open draft' }).click()
  const summaryDraft = page.getByLabel('Write a new note')
  await expect(summaryDraft).toContainText('The project review is next Tuesday at noon.')
  await summaryDraft.fill('# project-review transcript\n\n## Summary\n\nGenerate a summary from this transcript.\n\n## Transcript\n\nEdited only in the new draft.\n')
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await filed.getByRole('button', { name: 'Summarize draft' }).click()
  await expect.poll(() => summarizedTranscript).toBe('Edited only in the new draft.')
  await expect(summaryDraft).toContainText('The project review is Wednesday at noon.')
  await expect(summaryDraft).toContainText('Edited only in the new draft.')
  const filedNoteAfterSummary = await request.get(`/api/note?id=${encodeURIComponent(filedNoteId)}`, {
    headers: { 'x-folio-bundle': sourceBundleId },
  })
  expect((await filedNoteAfterSummary.json()).content).toBe(filedNoteBeforeSummary)
  const rawSessionId = Array.from(processedSessionIds)[0]
  expect(rawSessionId).toBeDefined()
  if (!rawSessionId) throw new Error('The transcription session was not recorded.')
  const rawSession = await page.evaluate(async (id) => {
    const response = await fetch(`/api/transcriptions/${id}`)
    return await response.json() as { result: { transcript: string } }
  }, rawSessionId)
  expect(rawSession.result.transcript).toBe('The project review is next Tuesday at noon.')

  await filed.getByRole('button', { name: 'Delete' }).click()
  await expect(filed.getByText(/Any opened or saved Markdown note will be kept/)).toBeVisible()
  await filed.getByRole('button', { name: 'Delete recording' }).click()
  await expect(filed).toHaveCount(0)
  await expect.poll(async () => {
    const response = await request.get('/api/transcriptions?pending=1')
    const sessions = await response.json()
    return sessions.some((session: { fileName: string }) => session.fileName === 'project-review.wav')
  }).toBe(false)
  await expect.poll(async () => {
    const response = await request.get(`/api/note?id=${encodeURIComponent(filedNoteId)}`, {
      headers: { 'x-folio-bundle': sourceBundleId },
    })
    return response.ok() ? (await response.json()).content : ''
  }).toBe(filedNoteBeforeSummary)
})
