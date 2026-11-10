import { expect, test, type Page } from '@playwright/test'

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } })

type UploadState = { value: { contentType: string | undefined; bytes: Buffer } | null }
type SessionState = { value: Record<string, unknown> | null }

async function mockTranscriptionApi(page: Page) {
  const sessionState: SessionState = { value: null }
  const uploadState: UploadState = { value: null }
  const creation: { body: Record<string, unknown> | null } = { body: null }
  await page.route('**/api/transcriptions/status', (route) => route.fulfill({ json: {
    model: 'mlx-community/whisper-large-v3-turbo', revision: 'test-revision',
    available: true, helperAvailable: true, modelState: 'ready', downloadedBytes: 1_610_000_000,
    totalBytes: 1_610_000_000, downloadPercent: 100, canInstall: true, canTranscribe: true, installing: false,
    diarization: {
      modelId: 'sortformer', modelName: 'Sortformer Speaker Labels',
      model: 'mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16', maxSpeakers: 4,
      modelState: 'ready', downloadedBytes: 236_110_000, totalBytes: 236_110_000,
      downloadPercent: 100, canInstall: true, canDiarize: true, installing: false,
    },
  } }))
  await page.route('**/api/transcriptions?pending=1', (route) => route.fulfill({ json: sessionState.value ? [sessionState.value] : [] }))
  await page.route('**/api/transcriptions', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    creation.body = body
    sessionState.value = {
      id: '33333333-3333-4333-8333-333333333333', state: 'recorded', draftId: null,
      durationMs: body.durationMs, error: null, createdAt: new Date().toISOString(),
      fileName: body.fileName, source: 'file', sourceBundleId: body.sourceBundleId,
    }
    await route.fulfill({ json: { session: sessionState.value } })
  })
  await page.route('**/api/transcriptions/*/audio', async (route) => {
    uploadState.value = { contentType: route.request().headers()['content-type'], bytes: route.request().postDataBuffer() ?? Buffer.alloc(0) }
    await route.fulfill({ json: { saved: true } })
  })
  return { sessionState, uploadState, creation }
}

const OSCILLATOR_STREAM = `
  async () => {
    const audioContext = new AudioContext()
    await audioContext.resume()
    const source = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const destination = audioContext.createMediaStreamDestination()
    gain.gain.value = 0.04
    source.connect(gain).connect(destination)
    source.start()
    return destination.stream
  }
`

test('records microphone audio, converts it to mono 16 kHz WAV, and saves it through local import', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['microphone'], { origin: baseURL })
  await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
  await page.addInitScript(`Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: (${OSCILLATOR_STREAM}) })`)
  const { sessionState, uploadState, creation } = await mockTranscriptionApi(page)

  await page.goto(baseURL!)
  await page.getByRole('button', { name: 'Todo List', exact: true }).click()
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await expect(page.getByRole('checkbox', { name: /^Identify speakers/ })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: /Record/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await page.waitForTimeout(1_100)
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect.poll(() => uploadState.value?.bytes.length ?? 0).toBeGreaterThan(44)

  const upload = uploadState.value as { contentType: string | undefined; bytes: Buffer }
  expect(upload.contentType).toBe('audio/wav')
  expect(upload.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
  expect(upload.bytes.subarray(8, 12).toString('ascii')).toBe('WAVE')
  expect(upload.bytes.readUInt16LE(22)).toBe(1)
  expect(upload.bytes.readUInt32LE(24)).toBe(16_000)
  expect(sessionState.value?.fileName).toMatch(/^Recording .*\.wav$/)
  expect(creation.body).not.toHaveProperty('sourceNoteId')
  expect(creation.body).not.toHaveProperty('identifySpeakers')
  await expect(page.locator('.transcription-row')).toHaveCount(1)
  await expect(page.locator('.transcription-row-action')).toHaveText(['Transcribe'])
})

test('records microphone and system audio together when the desktop shell offers it', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['microphone'], { origin: baseURL })
  await page.addInitScript(`
    localStorage.setItem('folio:model-setup-prompt-seen', '1')
    window.folio = { systemAudio: { supported: true }, openSystemAudioSettings: async () => undefined }
  `)
  await page.addInitScript(`
    const makeStream = ${OSCILLATOR_STREAM}
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: makeStream })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: makeStream })
  `)
  const { uploadState, creation } = await mockTranscriptionApi(page)

  await page.goto(baseURL!)
  await page.getByRole('button', { name: 'Todo List', exact: true }).click()
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await expect(page.getByRole('combobox', { name: /Record/ })).toHaveValue('mixed')
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByText('Recording microphone and system audio')).toBeVisible()
  await expect(page.getByRole('meter', { name: 'System level' })).toBeVisible()
  await page.waitForTimeout(1_100)
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect.poll(() => uploadState.value?.bytes.length ?? 0).toBeGreaterThan(44)

  const upload = uploadState.value as { contentType: string | undefined; bytes: Buffer }
  expect(upload.contentType).toBe('audio/wav')
  expect(upload.bytes.readUInt16LE(22)).toBe(1)
  expect(upload.bytes.readUInt32LE(24)).toBe(16_000)
  expect(creation.body).not.toHaveProperty('identifySpeakers')
  await expect(page.locator('.transcription-row')).toHaveCount(1)
})
