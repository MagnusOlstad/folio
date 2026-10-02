import { expect, test } from '@playwright/test'

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } })

test('records microphone audio, converts it to WAV, and saves it through local import', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['microphone'], { origin: baseURL })
  await page.addInitScript(() => localStorage.setItem('folio:model-setup-prompt-seen', '1'))
  await page.addInitScript(`
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const audioContext = new AudioContext()
        await audioContext.resume()
        const source = audioContext.createOscillator()
        const gain = audioContext.createGain()
        const destination = audioContext.createMediaStreamDestination()
        gain.gain.value = 0.04
        source.connect(gain).connect(destination)
        source.start()
        return destination.stream
      },
    })
  `)

  const sessionState: { value: Record<string, unknown> | null } = { value: null }
  const uploadState: { value: { contentType: string | undefined; bytes: Buffer } | null } = { value: null }
  let creationBody: Record<string, unknown> | null = null
  await page.route('**/api/transcriptions/status', (route) => route.fulfill({ json: {
    model: 'mlx-community/whisper-large-v3-turbo', revision: 'test-revision',
    available: true, helperAvailable: true, modelState: 'ready', downloadedBytes: 1_610_000_000,
    totalBytes: 1_610_000_000, downloadPercent: 100, canInstall: true, canTranscribe: true, installing: false,
  } }))
  await page.route('**/api/transcriptions?pending=1', (route) => route.fulfill({ json: sessionState.value ? [sessionState.value] : [] }))
  await page.route('**/api/transcriptions', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    creationBody = body
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

  await page.goto(baseURL!)
  await page.getByRole('button', { name: 'Todo List', exact: true }).click()
  await page.getByRole('tab', { name: 'Transcription' }).click()
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await page.waitForTimeout(1_100)
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect.poll(() => uploadState.value?.bytes.length ?? 0).toBeGreaterThan(44)

  const upload = uploadState.value as { contentType: string | undefined; bytes: Buffer }
  expect(upload.contentType).toBe('audio/wav')
  expect(upload.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
  expect(upload.bytes.subarray(8, 12).toString('ascii')).toBe('WAVE')
  expect(sessionState.value?.fileName).toMatch(/^Recording .*\.wav$/)
  expect(creationBody).not.toHaveProperty('sourceNoteId')
})
