import { expect, test } from '@playwright/test'

/** A 30 s silent 8 kHz mono WAV the browser can actually play. */
function silentWav(seconds = 30) {
  const samples = 8_000 * seconds
  const buffer = Buffer.alloc(44 + samples, 128)
  buffer.write('RIFF', 0, 'ascii'); buffer.writeUInt32LE(36 + samples, 4); buffer.write('WAVEfmt ', 8, 'ascii')
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8_000, 24); buffer.writeUInt32LE(8_000, 28); buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34)
  buffer.write('data', 36, 'ascii'); buffer.writeUInt32LE(samples, 40)
  return buffer
}

test('imports audio, downloads local Whisper, files an editable note, and summarizes its edits', async ({ page, request }) => {
  let installed = false
  let speakerModelInstalled = false
  const importBodies: Record<string, unknown>[] = []
  let summarizedTranscript = ''
  let filedNoteId = ''
  let sourceBundleId = ''
  let importBody: Record<string, unknown> | null = null
  const processedSessionIds = new Set<string>()
  const activeSessionIds = new Set<string>()
  const rawResults = new Map<string, Record<string, unknown>>()
  const processBodies: Record<string, unknown>[] = []
  let releaseTranscription = () => {}
  await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/transcriptions' && request.method() === 'POST') {
      importBody = request.postDataJSON() as Record<string, unknown>
      importBodies.push(importBody)
    }
  })
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname !== '/api/notes' || response.request().method() !== 'POST') return
    const payload = await response.json()
    filedNoteId = payload.note?.id || ''
  })
  await page.route('**/api/transcriptions/status', (route) => route.fulfill({ json: {
    modelId: 'whisper', modelName: 'Whisper Large v3 Turbo',
    model: 'mlx-community/whisper-large-v3-turbo', revision: 'test-revision',
    available: true, helperAvailable: true, modelState: installed ? 'ready' : 'missing',
    downloadedBytes: installed ? 1_610_000_000 : 0, totalBytes: 1_610_000_000,
    downloadPercent: installed ? 100 : 0, canInstall: true, canTranscribe: installed, installing: false,
    diarization: {
      modelId: 'sortformer', modelName: 'Sortformer Speaker Labels',
      model: 'mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16', maxSpeakers: 4,
      modelState: speakerModelInstalled ? 'ready' : 'missing',
      downloadedBytes: speakerModelInstalled ? 236_110_000 : 0, totalBytes: 236_110_000,
      downloadPercent: speakerModelInstalled ? 100 : 0, canInstall: true, canDiarize: speakerModelInstalled, installing: false,
    },
  } }))
  await page.route('**/api/transcriptions/speakers/install', async (route) => {
    speakerModelInstalled = true
    await route.fulfill({ json: { modelState: 'ready', canDiarize: true } })
  })
  await page.route('**/api/transcriptions/model/install', async (route) => {
    installed = true
    await route.fulfill({ json: { modelState: 'ready', canTranscribe: true } })
  })
  await page.route('**/api/transcriptions?pending=1', async (route) => {
    const upstream = await route.fetch()
    const sessions = await upstream.json()
    await route.fulfill({ json: sessions.map((session: { id: string; state: string }) => activeSessionIds.has(session.id)
      ? { ...session, state: 'transcribing', progressPercent: 37 }
      : session.state === 'recorded' && processedSessionIds.has(session.id) ? { ...session, state: 'ready' } : session) })
  })
  await page.route('**/api/transcriptions/*/process', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>
    processBodies.push(body)
    if (body.retranscribe === true && id) {
      const redone = {
        summary: '', transcript: '[00:02] The project review moved to Thursday at noon.',
        plainText: 'The project review moved to Thursday at noon.', speakers: false,
        segments: [{ start: 2.1, end: 5, text: 'The project review moved to Thursday at noon.' }],
      }
      rawResults.set(id, redone)
      const { session } = await (await request.get(`/api/transcriptions/${id}`)).json()
      await route.fulfill({ json: { session: { ...session, state: 'ready' }, result: redone } })
      return
    }
    if (id) activeSessionIds.add(id)
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, 10_000)
      releaseTranscription = () => { clearTimeout(fallback); resolve() }
    })
    const result = {
      summary: '', transcript: '[00:01] The project review is next Tuesday at noon.',
      plainText: 'The project review is next Tuesday at noon.', speakers: false,
      segments: [{ start: 1.2, end: 4.8, text: 'The project review is next Tuesday at noon.' }],
    }
    if (id) { activeSessionIds.delete(id); processedSessionIds.add(id); rawResults.set(id, result) }
    const sessionResponse = await request.get(`/api/transcriptions/${id}`)
    const { session } = await sessionResponse.json()
    sourceBundleId = session.sourceBundleId
    await route.fulfill({ json: { session: { ...session, state: 'ready' }, result } })
  })
  await page.route('**/api/transcriptions/*/summarize', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) || ''
    summarizedTranscript = String(rawResults.get(id)?.transcript || '')
    await route.fulfill({ json: { result: {
      summary: '- The project review is Wednesday at noon.',
      transcript: summarizedTranscript,
    } } })
  })
  await page.route(/\/api\/transcriptions\/[^/]+\/audio(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return }
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() })
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
  await page.getByRole('button', { name: 'Todo List', exact: true }).click()
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await expect(page.getByText(/Download mlx-community\/whisper-large-v3-turbo/)).toBeVisible()
  await page.getByRole('button', { name: 'Download Whisper Large v3 Turbo' }).click()
  await expect(page.getByText(/Download mlx-community/)).toHaveCount(0)

  await expect(page.getByRole('checkbox', { name: /^Identify speakers/ })).toHaveCount(0)
  await page.getByLabel('Choose local audio file').setInputFiles({
    name: 'project-review.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFF-local-audio-fixture'),
  })
  const imported = page.locator('.transcription-row').filter({ hasText: 'project-review.wav' })
  await expect(imported).toBeVisible()
  await expect.poll(() => importBody).not.toBeNull()
  expect(importBody).not.toHaveProperty('sourceNoteId')
  expect(importBody).toMatchObject({ fileName: 'project-review.wav' })
  const tabsBeforeTranscribe = await page.locator('.editor-tab').count()
  await imported.getByRole('button', { name: 'Transcribe' }).first().click()
  await expect(imported.getByText('Transcribing… 37%')).toBeVisible()
  await expect(imported.locator('.transcription-row-action')).toHaveText(['Cancel'])
  await expect(imported.locator('.transcription-download-progress')).toHaveCount(0)
  releaseTranscription()
  const draftEditor = page.getByLabel('Write a new note')
  await expect(draftEditor).toBeVisible()
  await expect(draftEditor).toContainText('Source audio: project-review.wav')
  await expect(draftEditor).toContainText('[00:01] The project review is next Tuesday at noon.')
  await expect(page.locator('.editor-tab')).toHaveCount(tabsBeforeTranscribe + 1)
  const countLocalDraftsContaining = (text: string) => page.evaluate(({ bundleId, needle }) => {
    const stored = localStorage.getItem(`folio:drafts:v2:${bundleId}`)
    if (!stored) return 0
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return 0
    return parsed.filter((entry): entry is { id: string; content: string } => Boolean(entry)
      && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.content === 'string')
      .filter((entry) => entry.id.startsWith('untitled:') && entry.content.includes(needle)).length
  }, { bundleId: sourceBundleId, needle: text })
  await expect.poll(() => countLocalDraftsContaining('The project review is next Tuesday at noon.')).toBe(1)
  const transcriptNote = '# project-review transcript\n\n- Source audio: project-review.wav\n- Imported: today\n- Duration: Unknown\n\n## Summary\n\nGenerate a summary from this transcript.\n\n## Transcript\n\nCorrected: the project review is Wednesday at noon.\n'
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
  const filed = page.locator('.transcription-row').filter({ hasText: 'project-review.wav' })
  const tabsBeforeOpen = await page.locator('.editor-tab').count()
  await expect(filed.locator('.transcription-row-action')).toHaveCount(0)
  await filed.getByRole('button', { name: 'More actions for project-review.wav' }).click()
  await page.getByRole('menuitem', { name: 'Open draft', exact: true }).click()
  await expect(page.locator('.editor-tab')).toHaveCount(tabsBeforeOpen + 1)
  const summaryDraft = page.getByLabel('Write a new note')
  await expect(summaryDraft).toContainText('The project review is next Tuesday at noon.')
  await expect.poll(() => countLocalDraftsContaining('The project review is next Tuesday at noon.')).toBe(1)
  await summaryDraft.fill('# project-review transcript\n\n## Summary\n\nGenerate a summary from this transcript.\n\n## Transcript\n\nEdited only in the new draft.\n')
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await filed.getByRole('button', { name: 'More actions for project-review.wav' }).click()
  await page.getByRole('menuitem', { name: 'Summarize again' }).click()
  await expect.poll(() => summarizedTranscript).toBe('[00:01] The project review is next Tuesday at noon.')
  await expect(summaryDraft).toContainText('Edited only in the new draft.')
  await expect(summaryDraft).not.toContainText('The project review is Wednesday at noon.')
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
  expect(rawSession.result.transcript).toBe('[00:01] The project review is next Tuesday at noon.')

  // Re-transcribing updates the recording while leaving the open draft alone.
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await filed.getByRole('button', { name: 'More actions for project-review.wav' }).click()
  await page.getByRole('menuitem', { name: 'Re-transcribe…' }).click()
  await expect(filed.getByText(/Open drafts will stay unchanged/)).toBeVisible()
  await filed.getByRole('group', { name: /Confirm re-transcription/ }).getByRole('button', { name: 'Re-transcribe' }).click()
  await expect.poll(() => processBodies.at(-1)).toEqual({ retranscribe: true })
  await expect(summaryDraft).toContainText('Edited only in the new draft.')
  await expect(summaryDraft).not.toContainText('[00:02] The project review moved to Thursday at noon.')
  expect(processBodies[0]).toEqual({})

  // Expanding the ready card shows the player inside it; the play button toggles real audio playback.
  const header = filed.getByRole('button', { name: /^project-review\.wav, / })
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  const player = filed.getByRole('group', { name: 'Player for project-review.wav' })
  await expect(player).toBeVisible()
  await expect(player.getByText('The project review moved to Thursday at noon.')).toBeVisible()
  await player.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await player.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  // Recording-wide speaker merge keeps the first selected identity and persists the new result.
  const speakerResult = {
    summary: '', speakers: true, speakerCount: 3, speakerNumbers: [1, 2, 3],
    segments: [
      { start: 1, end: 2, text: 'First.', speaker: 1 },
      { start: 2, end: 3, text: 'Second.', speaker: 2 },
      { start: 3, end: 4, text: 'Third.', speaker: 3 },
    ],
    transcript: '**{{speaker1}}** [00:01]\nFirst.\n\n**{{speaker2}}** [00:02]\nSecond.\n\n**{{speaker3}}** [00:03]\nThird.',
  }
  rawResults.set(rawSessionId, speakerResult)
  let mergeAttempts = 0
  await page.route(/\/api\/transcriptions\/[^/]+\/speakers\/merge$/, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ source: 2, target: 1 })
    mergeAttempts += 1
    if (mergeAttempts === 1) {
      await route.fulfill({ status: 400, json: { error: 'Both speakers must be present in this transcript.' } })
      return
    }
    const mergedResult = {
      ...speakerResult, speakerCount: 2, speakerNumbers: [1, 3],
      segments: speakerResult.segments.map((segment) => segment.speaker === 2 ? { ...segment, speaker: 1 } : segment),
      transcript: '**{{speaker1}}** [00:01]\nFirst. Second.\n\n**{{speaker3}}** [00:03]\nThird.',
    }
    rawResults.set(rawSessionId, mergedResult)
    await route.fulfill({ json: { result: mergedResult } })
  })
  await header.click()
  await header.click()
  await expect(player.getByRole('button', { name: 'Merge speakers' })).toBeVisible()
  await player.getByRole('button', { name: 'Merge speakers' }).click()
  await player.getByRole('button', { name: /Speaker 1/ }).first().click()
  await player.getByRole('button', { name: /Speaker 2/ }).first().click()
  await expect(player.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled()
  await player.getByRole('button', { name: 'Cancel' }).click()
  await expect(player.getByRole('button', { name: 'Merge speakers' })).toBeFocused()
  await player.getByRole('button', { name: 'Merge speakers' }).click()
  await player.getByRole('button', { name: /Speaker 1/ }).first().click()
  await player.getByRole('button', { name: /Speaker 2/ }).first().click()
  await player.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(player.getByRole('alert')).toContainText('Both speakers must be present')
  await player.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(player.getByText('Speakers merged in the recording.')).toBeVisible()
  await expect(player.getByRole('button', { name: /Speaker 2/ })).toHaveCount(0)
  await expect(player.locator('.player-chip').filter({ hasText: 'Speaker 3' })).toBeVisible()
  await expect(player.getByRole('status').filter({ hasText: 'Speakers merged' })).toBeFocused()

  // A recording-pane rename is saved to the result and reloads independently of the open draft.
  const mergedRecording = rawResults.get(rawSessionId)
  if (!mergedRecording) throw new Error('The merged result was not recorded.')
  let namedRecording: Record<string, unknown> = mergedRecording
  await page.route(/\/api\/transcriptions\/[^/]+\/speakers\/name$/, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ speaker: 1, name: 'Recorded Alex' })
    namedRecording = { ...namedRecording, speakerNames: { '1': 'Recorded Alex' } }
    rawResults.set(rawSessionId, namedRecording)
    await route.fulfill({ json: { result: namedRecording } })
  })
  const savedDraftContent = await summaryDraft.textContent()
  await player.getByRole('button', { name: /Speaker 1/ }).first().click()
  await player.getByRole('button', { name: 'Rename Speaker 1' }).click()
  const renameInput = player.getByRole('textbox', { name: 'Name for Speaker 1' })
  await renameInput.fill('Recorded Alex')
  await renameInput.press('Enter')
  await expect(player.getByText('Recorded Alex', { exact: true }).first()).toBeVisible()
  await expect(summaryDraft).toHaveText(savedDraftContent || '')
  await page.reload()
  await page.getByRole('button', { name: 'Todo List', exact: true }).click()
  await page.getByRole('tab', { name: 'Transcription' }).click()
  const reloaded = page.locator('.transcription-row').filter({ hasText: 'project-review.wav' })
  await reloaded.getByRole('button', { name: /^project-review\.wav, / }).click()
  const reloadedPlayer = reloaded.getByRole('group', { name: 'Player for project-review.wav' })
  await expect(reloadedPlayer.getByText('Recorded Alex', { exact: true }).first()).toBeVisible()

  // Speaker labels are a per-audio choice made on the imported item; choosing them offers the optional model download.
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await page.getByLabel('Choose local audio file').setInputFiles({
    name: 'interview.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFF-local-audio-fixture-two'),
  })
  const interview = page.locator('.transcription-row').filter({ hasText: 'interview.wav' })
  await expect(interview).toBeVisible()
  expect(importBodies.at(-1)).toMatchObject({ fileName: 'interview.wav' })
  await expect(page.getByText('Sortformer Speaker Labels is not installed')).toBeVisible()
  await page.getByRole('button', { name: 'Download Sortformer Speaker Labels' }).click()
  await expect(page.getByText('Sortformer Speaker Labels is not installed')).toHaveCount(0)

  await filed.getByRole('button', { name: 'More actions for project-review.wav' }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
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
