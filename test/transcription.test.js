import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import express from 'express'
import { createTranscriptionStorage } from '../server/transcription/storage.js'
import { createTranscriptionService, TRANSCRIPTION_MODEL } from '../server/transcription/service.js'
import { createMlxService } from '../server/mlx/service.js'
import { DIARIZATION_MODELS, TRANSCRIPTION_MODELS } from '../server/transcription/models.js'
import { safeAudioFilename, safeTranscriptionId, splitTranscript } from '../server/transcription/model.js'
import { registerRoutes } from '../server/transcription/routes.js'
import { buildTranscriptResult } from '../server/transcription/segments.js'
import { runHelper } from '../server/transcription/helper.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-transcription-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const executable = path.join(root, 'folio-mlx')
  await fs.writeFile(executable, '')
  const runtime = {
    projectRoot: root,
    modelRoot: path.join(root, 'models'),
    transcriptionsRoot: path.join(root, 'transcriptions'),
    mlxHelperPath: executable,
    transcriptionStorage: null,
    platform: 'darwin',
    architecture: 'arm64',
    osRelease: () => '23.0.0',
  }
  runtime.transcriptionStorage = createTranscriptionStorage(runtime)
  return { root, runtime }
}

async function installSnapshot(runtime, model = TRANSCRIPTION_MODELS.whisper) {
  const directory = path.join(runtime.modelRoot, 'hf-cache', `models--${model.repository.replaceAll('/', '--')}`, 'snapshots', model.revision)
  await fs.mkdir(directory, { recursive: true })
  const files = {
    'config.json': JSON.stringify({ model_type: 'whisper', ...(model.id === 'whisperlarge' ? { vocab_size: 51866 } : { n_vocab: 51866 }) }),
    [model.id === 'whisperlarge' ? 'model.safetensors' : 'weights.safetensors']: 'weights',
    'tokenizer.json': '{}',
    'tokenizer_config.json': '{}',
    'special_tokens_map.json': '{}',
    'added_tokens.json': '{}',
    'vocab.json': '{}',
    'merges.txt': 'merge',
    'normalizer.json': '{}',
    'generation_config.json': '{}',
  }
  await Promise.all(Object.entries(files).map(([name, contents]) => fs.writeFile(path.join(directory, name), contents)))
  return directory
}

test('local audio import accepts only supported extensions and sanitizes path components', () => {
  assert.deepEqual(safeAudioFilename('C:\\Users\\me\\meeting.M4A'), { filename: 'meeting.M4A', extension: '.m4a' })
  assert.equal(safeAudioFilename('meeting.exe'), null)
  assert.equal(safeTranscriptionId('11111111-1111-4111-8111-111111111111'), '11111111-1111-4111-8111-111111111111')
  assert.equal(safeTranscriptionId('../escape'), null)
  assert.deepEqual(splitTranscript('first\n\nsecond\n\nthird', 8), ['first', 'second', 'third'])
})

test('one-shot helper forwards only matching transcription progress and waits for the final response', async (t) => {
  const { root } = await fixture(t)
  const executable = path.join(root, 'progress-helper.mjs')
  await fs.writeFile(executable, `#!/usr/bin/env node
import readline from 'node:readline'
process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n')
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  process.stdout.write(JSON.stringify({ event: 'transcription-progress', id: 'stale', percent: 50 }) + '\\n')
  process.stdout.write(JSON.stringify({ event: 'transcription-progress', id: request.id, percent: 62 }) + '\\n')
  process.stdout.write(JSON.stringify({ id: request.id, text: 'Final transcript.' }) + '\\n')
}
`, { mode: 0o755 })
  await fs.chmod(executable, 0o755)
  const events = []
  const response = await runHelper({
    executable,
    args: [],
    cacheRoot: root,
    request: { id: 'current-request', operation: 'transcribe' },
    onEvent: (event) => events.push(event),
  })
  assert.equal(response.text, 'Final transcript.')
  assert.deepEqual(events.map(({ event, percent }) => [event, percent]), [['ready', undefined], ['transcription-progress', 62]])
})

test('binary audio upload streams through the JSON API without parsing or buffering it as JSON', async (t) => {
  const { runtime } = await fixture(t)
  const service = createTranscriptionService(runtime)
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  registerRoutes(app, { transcriptionService: service, transcriptionStorage: runtime.transcriptionStorage })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const createdResponse = await fetch(`${base}/api/transcriptions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'meeting.wav', sourceBundleId: 'bundle-upload', durationMs: 2500 }),
  })
  assert.equal(createdResponse.status, 201)
  const { session } = await createdResponse.json()
  const audio = Buffer.from('RIFF audio bytes')
  const uploadResponse = await fetch(`${base}/api/transcriptions/${session.id}/audio`, {
    method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: audio,
  })
  assert.equal(uploadResponse.status, 201)
  assert.equal((await uploadResponse.json()).session.state, 'recorded')
  assert.deepEqual(await fs.readFile(runtime.transcriptionStorage.recordingPath(session)), audio)
  const deletedResponse = await fetch(`${base}/api/transcriptions/${session.id}`, { method: 'DELETE' })
  assert.equal(deletedResponse.status, 200)
  assert.deepEqual(await deletedResponse.json(), { deleted: true })
  assert.equal((await fetch(`${base}/api/transcriptions/${session.id}`)).status, 404)
  assert.equal((await fetch(`${base}/api/transcriptions/not-an-id`, { method: 'DELETE' })).status, 400)
  assert.equal((await fetch(`${base}/api/transcriptions/11111111-1111-4111-8111-111111111111`, { method: 'DELETE' })).status, 404)
  await service.close()
})

test('deleting a session removes audio and transcript artifacts while retaining its Markdown note', async (t) => {
  const { root, runtime } = await fixture(t)
  const service = createTranscriptionService(runtime)
  const notePath = path.join(root, 'notes', 'meeting.md')
  await fs.mkdir(path.dirname(notePath), { recursive: true })
  await fs.writeFile(notePath, '# Edited transcript note\n')
  const session = await runtime.transcriptionStorage.createSession({
    fileName: 'meeting.wav', sourceBundleId: 'bundle-a', draftId: 'notes/meeting.md',
  })
  await runtime.transcriptionStorage.writeAudio(session.id, '.wav', Readable.from([Buffer.from('audio bytes')]))
  await runtime.transcriptionStorage.writeResult(session.id, { transcript: 'Local transcript', summary: 'Local summary' })
  await runtime.transcriptionStorage.writeManifest({ ...session, state: 'ready' })
  const audioPath = runtime.transcriptionStorage.recordingPath(session)
  const resultPath = runtime.transcriptionStorage.filePath(session.id, 'result.json')
  const manifestPath = runtime.transcriptionStorage.filePath(session.id, 'session.json')

  await service.deleteSession(session.id)

  for (const artifact of [audioPath, resultPath, manifestPath]) await assert.rejects(fs.access(artifact), { code: 'ENOENT' })
  assert.deepEqual(await service.list(), [])
  assert.equal(await fs.readFile(notePath, 'utf8'), '# Edited transcript note\n')
  await assert.rejects(runtime.transcriptionStorage.deleteSession('../notes'), /Invalid transcription ID/)
  assert.equal(await fs.readFile(notePath, 'utf8'), '# Edited transcript note\n')
  await service.close()
})

test('deletion conflicts with active uploads and transcription, then succeeds after the job ends', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  const service = createTranscriptionService(runtime)
  const session = await service.createFileSession({ fileName: 'meeting.wav' })
  await runtime.transcriptionStorage.writeAudio(session.id, '.wav', Readable.from([Buffer.from('audio')]))
  await runtime.transcriptionStorage.writeManifest({ ...session, state: 'recorded' })
  service.beginUpload(session.id)
  assert.throws(() => service.beginUpload(session.id), { status: 409 })
  await assert.rejects(service.deleteSession(session.id), { status: 409 })
  service.endUpload(session.id)

  let announceStarted
  let finishTranscription
  const started = new Promise((resolve) => { announceStarted = resolve })
  runtime.transcriptionRunner = () => new Promise((resolve) => { finishTranscription = resolve; announceStarted() })
  const processing = service.transcribe(session.id)
  await started
  await assert.rejects(service.deleteSession(session.id), { status: 409 })
  finishTranscription({ text: 'The session is still protected.' })
  await processing
  await service.deleteSession(session.id)
  assert.equal(await runtime.transcriptionStorage.readManifest(session.id), null)
  await service.close()
})

test('transcription progress is transient, monotonic, session scoped, and reaches 100 only after saving', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  let announceStarted
  let finishTranscription
  let sendEvent
  const started = new Promise((resolve) => { announceStarted = resolve })
  runtime.transcriptionRunner = ({ request, onEvent }) => new Promise((resolve) => {
    sendEvent = (percent, id = request.id) => onEvent({ event: 'transcription-progress', id, percent })
    finishTranscription = () => resolve({ id: request.id, text: 'Progressed transcript.' })
    announceStarted()
  })
  const service = createTranscriptionService(runtime)
  const session = await service.createFileSession({ fileName: 'progress.wav' })
  await runtime.transcriptionStorage.writeAudio(session.id, '.wav', Readable.from([Buffer.from('audio')]))
  await runtime.transcriptionStorage.writeManifest({ ...session, state: 'recorded' })
  assert.equal((await service.getSession(session.id)).session.progressPercent, 0)

  const processing = service.transcribe(session.id)
  await started
  sendEvent(80, 'another-request')
  sendEvent(140)
  assert.equal((await service.list()).find((item) => item.id === session.id).progressPercent, 0)
  sendEvent(48)
  sendEvent(23)
  assert.equal((await service.list()).find((item) => item.id === session.id).progressPercent, 48)
  assert.equal((await service.getSession(session.id)).session.progressPercent, 48)
  const persisted = await runtime.transcriptionStorage.readManifest(session.id)
  assert.equal('progressPercent' in persisted, false)

  finishTranscription()
  const completed = await processing
  assert.equal(completed.session.progressPercent, 100)
  assert.equal((await service.list()).find((item) => item.id === session.id).progressPercent, 100)
  assert.equal((await service.getSession(session.id)).session.progressPercent, 100)
  await service.close()
})

test('Whisper installation aggregates model and tokenizer scopes and resets progress after retry', async (t) => {
  const { runtime } = await fixture(t)
  let attempt = 0
  let finishRetry
  runtime.transcriptionInstaller = async ({ onEvent }) => {
    attempt += 1
    if (attempt === 1) {
      onEvent({ event: 'download-progress', scope: 'model', downloadedBytes: 1_500_000_000, totalBytes: 1_600_000_000, complete: true })
      onEvent({ event: 'download-progress', scope: 'tokenizer', downloadedBytes: 3_000_000, totalBytes: 4_000_000 })
      throw new Error('Tokenizer download failed.')
    }
    onEvent({ event: 'download-progress', scope: 'tokenizer', downloadedBytes: 1_000, totalBytes: 4_000 })
    await new Promise((resolve) => { finishRetry = resolve })
    return installSnapshot(runtime)
  }
  const service = createTranscriptionService(runtime)
  await assert.rejects(service.install(), /Tokenizer download failed/)
  const failed = await service.status()
  assert.equal(failed.installing, false)
  assert.equal(failed.downloadedBytes, 0, 'failed-install progress is not retained for the next attempt')
  assert.equal(failed.downloadPercent, 0)

  const retry = service.install()
  const deadline = Date.now() + 2_000
  let inProgress
  while (Date.now() < deadline) {
    inProgress = await service.status()
    if (inProgress.installing && inProgress.downloadedBytes > 0) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(inProgress?.downloadedBytes, 1_000)
  assert.equal(inProgress?.totalBytes, TRANSCRIPTION_MODELS.whisper.downloadSizeBytes)
  assert.equal(inProgress?.downloadPercent, 0, 'retry starts with only its current stage bytes')
  finishRetry?.()
  await retry
  assert.equal((await service.status()).downloadPercent, 100)
  await service.close()
})

test('Whisper stage progress stays monotonic for both models and ignores cached or historical bytes', async (t) => {
  for (const modelId of ['whisper', 'whisperlarge']) {
    const { runtime } = await fixture(t)
    const model = TRANSCRIPTION_MODELS[modelId]
    let sendEvent
    let finishInstall
    let announceStarted
    const started = new Promise((resolve) => { announceStarted = resolve })
    runtime.mlxService = { selectedTranscriptionModel: async () => modelId }
    runtime.transcriptionInstaller = async ({ onEvent }) => {
      sendEvent = onEvent
      announceStarted()
      await new Promise((resolve) => { finishInstall = resolve })
      return installSnapshot(runtime, model)
    }
    const repoRoot = path.join(runtime.modelRoot, 'hf-cache', `models--${model.repository.replaceAll('/', '--')}`)
    const historical = path.join(repoRoot, 'snapshots', 'previous-revision')
    await fs.mkdir(historical, { recursive: true })
    await fs.writeFile(path.join(historical, 'stale-weights'), Buffer.alloc(10_000_000))
    const blobs = path.join(repoRoot, 'blobs')
    await fs.mkdir(blobs, { recursive: true })
    await fs.writeFile(path.join(blobs, 'unrelated-complete-blob'), Buffer.alloc(20_000_000))
    await fs.writeFile(path.join(blobs, 'unrelated.incomplete'), Buffer.alloc(30_000_000))

    const service = createTranscriptionService(runtime)
    const installation = service.install()
    await started
    sendEvent({ event: 'download-progress', scope: 'model', downloadedBytes: 1, totalBytes: 1 })
    assert.equal((await service.status()).downloadedBytes, 0, `${modelId} cached sentinel must not look like one byte of progress`)

    const modelStageTotal = model.downloadSizeBytes - 4_000_000
    const progressEvents = [
      { scope: 'model', downloadedBytes: Math.floor(modelStageTotal * 0.5), totalBytes: modelStageTotal },
      { scope: 'model', downloadedBytes: Math.floor(modelStageTotal * 0.75), totalBytes: modelStageTotal },
      { scope: 'model', downloadedBytes: modelStageTotal, totalBytes: modelStageTotal, complete: true },
      { scope: 'tokenizer', downloadedBytes: 2_000_000, totalBytes: 4_000_000 },
    ]
    let previousPercent = 0
    for (const event of progressEvents) {
      sendEvent({ event: 'download-progress', ...event })
      const status = await service.status()
      assert.equal(status.totalBytes, model.downloadSizeBytes)
      assert.ok(status.downloadedBytes >= 0 && status.downloadedBytes <= model.downloadSizeBytes)
      assert.ok(status.downloadPercent >= previousPercent, `${modelId} progress regressed at ${event.scope} stage`)
      previousPercent = status.downloadPercent
    }
    const inProgress = await service.status()
    assert.equal(inProgress.downloadedBytes, model.downloadSizeBytes - 2_000_000)
    assert.equal(inProgress.downloadPercent, 99)
    finishInstall()
    await installation
    assert.equal((await service.status()).downloadPercent, 100)
    await service.close()
  }
})

test('deletion conflicts with active summary generation', async (t) => {
  const { runtime } = await fixture(t)
  let announceStarted
  let finishGeneration
  const started = new Promise((resolve) => { announceStarted = resolve })
  runtime.mlxService = { generate: () => new Promise((resolve) => { finishGeneration = resolve; announceStarted() }) }
  const service = createTranscriptionService(runtime)
  const session = await service.createFileSession({ fileName: 'meeting.wav' })
  await runtime.transcriptionStorage.writeResult(session.id, { transcript: 'Meeting transcript', summary: 'Previous summary' })
  const summary = service.summarize(session.id, 'Meeting transcript')
  await started
  await assert.rejects(service.deleteSession(session.id), { status: 409 })
  const cancelling = service.cancelSummary(session.id)
  finishGeneration({ text: 'Discard this generated summary.' })
  await assert.rejects(summary, /Summary cancelled/)
  assert.equal(await cancelling, true)
  await service.deleteSession(session.id)
  await service.close()
})

test('Whisper status requires its model-specific snapshot and transcribes from its local directory', async (t) => {
  const { runtime } = await fixture(t)
  runtime.transcriptionInstaller = async ({ args }) => {
    assert.ok(args.includes('--revision'))
    assert.ok(args.includes(TRANSCRIPTION_MODEL.revision))
    assert.ok(!args.includes('--cache-directory'))
    await fs.mkdir(path.join(runtime.modelRoot, 'hf-cache', `models--${TRANSCRIPTION_MODELS.whisper.repository.replaceAll('/', '--')}`, 'snapshots', TRANSCRIPTION_MODEL.revision), { recursive: true })
    return { event: 'ready' }
  }
  const runtimeStatus = async () => service.status()
  const service = createTranscriptionService(runtime)
  const initial = await runtimeStatus()
  assert.equal(initial.modelState, 'missing')
  assert.equal(initial.canTranscribe, false)
  await assert.rejects(service.install(), /configuration, weights, or tokenizer files are incomplete/)
  assert.equal((await service.status()).modelState, 'missing')
  runtime.transcriptionInstaller = async () => {
    await installSnapshot(runtime)
    return { event: 'ready' }
  }
  await service.install()
  assert.equal((await service.status()).modelState, 'ready')
  const session = await service.createFileSession({ fileName: 'meeting.wav', sourceBundleId: 'bundle-a', durationMs: 1250 })
  await runtime.transcriptionStorage.writeAudio(session.id, '.wav', Readable.from([Buffer.from('audio')]))
  await runtime.transcriptionStorage.writeManifest({ ...session, state: 'recorded' })
  const directory = path.join(runtime.modelRoot, 'hf-cache', `models--${TRANSCRIPTION_MODELS.whisper.repository.replaceAll('/', '--')}`, 'snapshots', TRANSCRIPTION_MODEL.revision)
  runtime.transcriptionRunner = async ({ args, request }) => {
    assert.ok(args.includes('--model-directory'))
    assert.ok(args.includes(directory))
    assert.equal(request.operation, 'transcribe')
    assert.match(request.audioPath, /recording\.wav$/)
    return { id: request.id, text: 'The meeting starts at ten.' }
  }
  const completed = await service.transcribe(session.id)
  assert.equal(completed.session.state, 'ready')
  assert.equal(completed.result.transcript, 'The meeting starts at ten.')
  assert.equal((await runtime.transcriptionStorage.readManifest(session.id)).sourceBundleId, 'bundle-a')
  await service.close()
})

test('full Whisper uses its pinned HF snapshot, independent install state, and captured model choice', async (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
  const originalRelease = os.release
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  Object.defineProperty(process, 'arch', { ...originalArch, value: 'arm64' })
  os.release = () => '23.0.0'
  const { root, runtime } = await fixture(t)
  t.after(async () => {
    await runtime.mlxService.close()
    Object.defineProperty(process, 'platform', originalPlatform)
    Object.defineProperty(process, 'arch', originalArch)
    os.release = originalRelease
  })
  runtime.mlxService = createMlxService({ projectRoot: root, modelRoot: runtime.modelRoot, mlxHelperPath: runtime.mlxHelperPath })
  const full = TRANSCRIPTION_MODELS.whisperlarge
  runtime.transcriptionInstaller = async ({ args }) => {
    assert.ok(args.includes(full.repository))
    assert.ok(args.includes(full.revision))
    await installSnapshot(runtime, full)
  }
  const service = createTranscriptionService(runtime)
  assert.equal((await service.status()).modelId, 'whisper')
  await service.selectModel('whisperlarge')
  const partialSnapshot = path.join(runtime.modelRoot, 'hf-cache', `models--${full.repository.replaceAll('/', '--')}`, 'snapshots', full.revision)
  await fs.mkdir(partialSnapshot, { recursive: true })
  for (const name of full.requiredFiles.filter((item) => !['model.safetensors', 'generation_config.json'].includes(item))) {
    await fs.writeFile(path.join(partialSnapshot, name), name === 'config.json' ? JSON.stringify({ model_type: 'whisper', vocab_size: 51866 }) : 'fixture')
  }
  await fs.writeFile(path.join(partialSnapshot, 'weights.safetensors'), 'wrong filename')
  assert.equal((await service.status()).modelState, 'missing')
  await service.install()
  assert.equal((await service.status()).modelId, 'whisperlarge')
  assert.equal((await service.status()).canTranscribe, true)
  const turbo = TRANSCRIPTION_MODELS.whisper
  assert.equal((await fs.stat(path.join(runtime.modelRoot, 'hf-cache', `models--${full.repository.replaceAll('/', '--')}`, 'snapshots', full.revision))).isDirectory(), true)
  await assert.rejects(fs.access(path.join(runtime.modelRoot, 'hf-cache', `models--${turbo.repository.replaceAll('/', '--')}`, 'snapshots', turbo.revision)), { code: 'ENOENT' })
  const session = await service.createFileSession({ fileName: 'meeting.wav' })
  await runtime.transcriptionStorage.writeAudio(session.id, '.wav', Readable.from([Buffer.from('audio')]))
  await runtime.transcriptionStorage.writeManifest({ ...session, state: 'recorded' })
  await service.selectModel('whisper')
  await assert.rejects(service.transcribe(session.id), /Download mlx-community\/whisper-large-v3-turbo/)
  await service.selectModel('whisperlarge')
  const snapshot = path.join(runtime.modelRoot, 'hf-cache', `models--${full.repository.replaceAll('/', '--')}`, 'snapshots', full.revision)
  runtime.transcriptionRunner = async ({ args, request }) => {
    assert.ok(args.includes(full.repository))
    assert.ok(args.includes(full.revision))
    assert.ok(args.includes(snapshot))
    return { id: request.id, text: 'Full model transcript.' }
  }
  const completed = await service.transcribe(session.id)
  assert.equal(completed.result.transcript, 'Full model transcript.')

  const queuedSessions = await Promise.all(['queued-a.wav', 'queued-b.wav'].map(async (fileName) => {
    const queued = await service.createFileSession({ fileName })
    await runtime.transcriptionStorage.writeAudio(queued.id, '.wav', Readable.from([Buffer.from('audio')]))
    return runtime.transcriptionStorage.writeManifest({ ...queued, state: 'recorded' })
  }))
  let announceStarted
  let finishFirst
  let runCount = 0
  const started = new Promise((resolve) => { announceStarted = resolve })
  const firstGate = new Promise((resolve) => { finishFirst = resolve })
  const capturedModels = []
  runtime.transcriptionRunner = async ({ args, request }) => {
    capturedModels.push(args[args.indexOf('--model') + 1])
    if (++runCount === 1) { announceStarted(); await firstGate }
    return { id: request.id, text: 'Captured model transcript.' }
  }
  const firstQueued = service.transcribe(queuedSessions[0].id)
  await started
  const secondQueued = service.transcribe(queuedSessions[1].id)
  const switchAfterQueue = service.selectModel('whisper')
  finishFirst()
  await Promise.all([firstQueued, secondQueued, switchAfterQueue])
  assert.deepEqual(capturedModels, [full.repository, full.repository])
  assert.equal((await service.status()).modelId, 'whisper')
  await service.close()
})

test('bundle-local transcription status reflects the shared Whisper installation', async (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
  const originalRelease = os.release
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  Object.defineProperty(process, 'arch', { ...originalArch, value: 'arm64' })
  os.release = () => '23.0.0'
  const { root, runtime } = await fixture(t)
  const helper = path.resolve('test/fixtures/fake-mlx-helper.js')
  const mlxService = createMlxService({ projectRoot: root, modelRoot: runtime.modelRoot, mlxHelperPath: helper })
  const logPath = path.join(root, 'helper.jsonl')
  const controlPath = path.join(root, 'control.json')
  const previousLog = process.env.FOLIO_MLX_FIXTURE_LOG
  const previousControl = process.env.FOLIO_MLX_FIXTURE_CONTROL
  process.env.FOLIO_MLX_FIXTURE_LOG = logPath
  process.env.FOLIO_MLX_FIXTURE_CONTROL = controlPath
  await fs.writeFile(controlPath, '{}')
  runtime.mlxService = mlxService
  let finishInstall
  const installGate = new Promise((resolve) => { finishInstall = resolve })
  runtime.transcriptionInstaller = async ({ onEvent }) => {
    onEvent({ event: 'download-progress', scope: 'model', downloadedBytes: 1, totalBytes: 1 })
    onEvent({ scope: 'model', downloadedBytes: 1_500_000_000, totalBytes: 1_600_000_000, complete: true })
    onEvent({ scope: 'tokenizer', downloadedBytes: 3_500_000, totalBytes: 4_000_000 })
    await installGate
    return installSnapshot(runtime)
  }
  const first = createTranscriptionService(runtime)
  const secondRuntime = {
    ...runtime,
    transcriptionsRoot: path.join(root, 'other-bundle-transcriptions'),
    transcriptionStorage: createTranscriptionStorage({ ...runtime, transcriptionsRoot: path.join(root, 'other-bundle-transcriptions') }),
  }
  const second = createTranscriptionService(secondRuntime)
  try {
    assert.equal((await second.status()).modelState, 'missing')
    const installation = first.install()
    let sharedProgress
    const installDeadline = Date.now() + 2_000
    while (Date.now() < installDeadline) {
      sharedProgress = await second.status()
      if (sharedProgress.installing) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(sharedProgress?.modelState, 'downloading')
    assert.equal(sharedProgress?.downloadedBytes, 1_503_500_000)
    assert.equal(sharedProgress?.totalBytes, TRANSCRIPTION_MODELS.whisper.downloadSizeBytes)
    assert.equal(sharedProgress?.downloadPercent, 93)
    finishInstall()
    await installation
    const shared = await second.status()
    assert.equal(shared.modelState, 'ready')
    assert.equal(shared.canTranscribe, true)
    assert.equal(shared.installing, false)

    await mlxService.install('gemma4')
    await fs.writeFile(controlPath, JSON.stringify({ operationDelayMs: 10_000 }))
    const session = await first.createFileSession({ fileName: 'meeting.wav' })
    await runtime.transcriptionStorage.writeResult(session.id, { summary: '', transcript: 'The meeting starts at ten and ends at noon.' })
    const summary = first.summarize(session.id, 'The meeting starts at ten and ends at noon.')
    const summaryResult = assert.rejects(summary, /Summary cancelled/)
    const deadline = Date.now() + 2_000
    let requestStarted = false
    while (Date.now() < deadline) {
      try {
        if ((await fs.readFile(logPath, 'utf8')).includes('"operation":"generate"')) {
          requestStarted = true
          break
        }
      } catch { /* first helper request has not been logged yet */ }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(requestStarted, true)
    let shutdownTimer
    const shutdownDeadline = new Promise((_, reject) => {
      shutdownTimer = setTimeout(() => reject(new Error('MLX shutdown waited for an active summary.')), 1_500)
    })
    try { await Promise.race([mlxService.close(), shutdownDeadline]) }
    finally { clearTimeout(shutdownTimer) }
    await summaryResult
  } finally {
    finishInstall()
    await Promise.all([first.close(), second.close(), mlxService.close()])
    if (previousLog === undefined) delete process.env.FOLIO_MLX_FIXTURE_LOG
    else process.env.FOLIO_MLX_FIXTURE_LOG = previousLog
    if (previousControl === undefined) delete process.env.FOLIO_MLX_FIXTURE_CONTROL
    else process.env.FOLIO_MLX_FIXTURE_CONTROL = previousControl
    Object.defineProperty(process, 'platform', originalPlatform)
    Object.defineProperty(process, 'arch', originalArch)
    os.release = originalRelease
  }
})

test('cancelling a transcription aborts its helper and retains the source audio', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  const service = createTranscriptionService(runtime)
  const session = await service.createFileSession({ fileName: 'long-interview.wav' })
  await runtime.transcriptionStorage.writeAudio(session.id, '.wav', Readable.from([Buffer.from('audio')]))
  await runtime.transcriptionStorage.writeManifest({ ...session, state: 'recorded' })
  let announceStarted
  const started = new Promise((resolve) => { announceStarted = resolve })
  let receivedSignal = false
  runtime.transcriptionRunner = ({ signal }) => new Promise((_resolve, reject) => {
    announceStarted()
    signal.addEventListener('abort', () => {
      receivedSignal = true
      reject(Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' }))
    }, { once: true })
  })
  const processing = service.transcribe(session.id)
  const processingRejected = assert.rejects(processing, /cancelled/i)
  await started
  const cancelled = await service.cancel(session.id)
  await processingRejected
  assert.equal(receivedSignal, true)
  assert.equal(cancelled.state, 'failed')
  assert.match(cancelled.error, /audio file is saved/i)
  assert.equal(await runtime.transcriptionStorage.hasRecording(session), true)
  await service.close()
})

test('filed transcript association follows the note ID within its source bundle', async (t) => {
  const { runtime } = await fixture(t)
  const service = createTranscriptionService(runtime)
  const first = await runtime.transcriptionStorage.createSession({
    draftId: 'untitled:transcript-1', source: 'file', fileName: 'one.mp3', audioExtension: '.mp3', sourceBundleId: 'bundle-a',
  })
  const second = await runtime.transcriptionStorage.createSession({
    draftId: 'untitled:transcript-1', source: 'file', fileName: 'two.mp3', audioExtension: '.mp3', sourceBundleId: 'bundle-b',
  })
  const updated = await service.remapDraft('untitled:transcript-1', 'notes/meeting.md', 'bundle-a')
  assert.equal(updated, 1)
  assert.equal((await runtime.transcriptionStorage.readManifest(first.id)).draftId, 'notes/meeting.md')
  assert.equal((await runtime.transcriptionStorage.readManifest(second.id)).draftId, 'untitled:transcript-1')
  await service.close()
})

test('summary failure leaves the raw session result unchanged', async (t) => {
  const { runtime } = await fixture(t)
  runtime.mlxService = { generate: async () => { throw new Error('no local text model') } }
  const service = createTranscriptionService(runtime)
  const session = await runtime.transcriptionStorage.createSession({ source: 'file', fileName: 'meeting.wav' })
  const raw = { summary: 'Original summary', transcript: 'Original transcript' }
  await runtime.transcriptionStorage.writeResult(session.id, raw)
  await assert.rejects(service.summarize(session.id, 'Edited transcript with a corrected date.'), /Install and start a text generation model/)
  assert.deepEqual(await runtime.transcriptionStorage.readResult(session.id), raw)
  await service.close()
})

test('summary generation persists summary fields without replacing the canonical transcript', async (t) => {
  const { runtime } = await fixture(t)
  runtime.mlxService = { generate: async () => ({ text: 'Derived summary.' }) }
  const service = createTranscriptionService(runtime)
  const session = await runtime.transcriptionStorage.createSession({ fileName: 'meeting.wav' })
  const raw = { summary: 'Original summary.', transcript: 'Original transcript.' }
  await runtime.transcriptionStorage.writeResult(session.id, raw)

  const derived = await service.summarize(session.id)

  assert.equal(derived.summary, 'Derived summary.')
  assert.equal(derived.transcript, 'Original transcript.')
  assert.deepEqual(await runtime.transcriptionStorage.readResult(session.id), derived)
  await service.close()
})

test('cancelling summary generation retains the draft text and original session result', async (t) => {
  const { runtime } = await fixture(t)
  let announceStarted
  let finishGeneration
  const started = new Promise((resolve) => { announceStarted = resolve })
  runtime.mlxService = { generate: () => new Promise((resolve) => { finishGeneration = resolve; announceStarted() }) }
  const service = createTranscriptionService(runtime)
  const session = await runtime.transcriptionStorage.createSession({ fileName: 'meeting.wav' })
  const raw = { summary: 'Previous summary.', transcript: 'Previous transcript.' }
  await runtime.transcriptionStorage.writeResult(session.id, raw)
  const summarizing = service.summarize(session.id)
  await started
  const cancelling = service.cancelSummary(session.id)
  finishGeneration({ text: 'This result must be discarded.' })
  await assert.rejects(summarizing, /Summary cancelled/)
  assert.equal(await cancelling, true)
  assert.deepEqual(await runtime.transcriptionStorage.readResult(session.id), raw)
  await service.close()
})

test('unsupported platforms expose setup guidance without attempting MLX installation', async (t) => {
  const { runtime } = await fixture(t)
  runtime.platform = 'linux'
  const service = createTranscriptionService(runtime)
  const unavailable = await service.status()
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.canInstall, false)
  await assert.rejects(service.install(), /Apple Silicon Mac running macOS 14 or later/)
  await service.close()
})

const PINNED_SORTFORMER = DIARIZATION_MODELS.sortformer

async function installSortformer(runtime, model = PINNED_SORTFORMER) {
  const directory = path.join(runtime.modelRoot, 'hf-cache', `models--${model.repository.replaceAll('/', '--')}`, 'snapshots', model.revision)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ model_type: 'sortformer' }))
  await fs.writeFile(path.join(directory, 'model.safetensors'), 'weights')
  return directory
}

async function recordedSession(runtime, service, options = {}) {
  const session = await service.createFileSession({ fileName: 'meeting.wav', ...options })
  await runtime.transcriptionStorage.writeAudio(session.id, '.wav', Readable.from([Buffer.from('audio')]))
  return runtime.transcriptionStorage.writeManifest({ ...(await runtime.transcriptionStorage.readManifest(session.id)), state: 'recorded' })
}

const MEETING_SEGMENTS = [
  { start: 0.5, end: 4, text: 'Welcome to the review.' },
  { start: 4, end: 8, text: 'Thanks for having me.' },
  { start: 8, end: 12, text: 'Let us begin.' },
]
const MEETING_TURNS = [{ start: 0, end: 4, speaker: 0 }, { start: 4, end: 8, speaker: 1 }, { start: 8, end: 12, speaker: 0 }]

test('without the speaker model the transcript gets timestamps from Whisper segments and no speaker labels', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  const calls = []
  runtime.transcriptionRunner = async ({ args, request }) => {
    calls.push({ args, operation: request.operation })
    return { id: request.id, text: 'Welcome to the review. Thanks for having me. Let us begin.', segments: MEETING_SEGMENTS }
  }
  const service = createTranscriptionService(runtime)
  const created = await service.createFileSession({ fileName: 'meeting.wav' })
  assert.equal(created.identifySpeakers, false)
  const session = await recordedSession(runtime, service)
  const completed = await service.transcribe(session.id)
  assert.deepEqual(calls.map((call) => call.operation), ['transcribe'])
  assert.equal(completed.result.transcript, '[00:00] Welcome to the review. Thanks for having me. Let us begin.')
  assert.equal(completed.result.speakers, false)
  assert.equal(completed.result.plainText, 'Welcome to the review. Thanks for having me. Let us begin.')
  assert.equal(completed.result.segments.length, 3)
  assert.match(completed.result.markdown, /# Transcript\n\n\[00:00\] Welcome/)
  await service.close()
})

test('a helper without segments keeps the plain transcript and skips speaker labels with a warning', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.diarizationModel = PINNED_SORTFORMER
  await installSortformer(runtime)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  const operations = []
  runtime.transcriptionRunner = async ({ request }) => { operations.push(request.operation); return { id: request.id, text: 'Only text.' } }
  const service = createTranscriptionService(runtime)
  const plain = await service.transcribe((await recordedSession(runtime, service)).id)
  assert.equal(plain.result.transcript, 'Only text.')
  assert.deepEqual(plain.result.segments, [])
  assert.match(plain.result.speakerWarning, /did not return segment timestamps/)
  const labelled = await service.transcribe((await recordedSession(runtime, service, { identifySpeakers: true })).id)
  assert.equal(labelled.result.transcript, 'Only text.')
  assert.match(labelled.result.speakerWarning, /did not return segment timestamps/)
  assert.deepEqual(operations, ['transcribe', 'transcribe'], 'no diarization pass without segments to label')
  await service.close()
})

test('Sortformer downloads on request with its pinned revision, then labels speakers after Whisper finishes', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.diarizationModel = PINNED_SORTFORMER
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  const service = createTranscriptionService(runtime)
  const session = await recordedSession(runtime, service)
  runtime.transcriptionRunner = async ({ request }) => ({ id: request.id, text: 'Hello there.', segments: [{ start: 1, end: 2, text: 'Hello there.' }] })
  const unlabelled = await service.transcribe(session.id)
  assert.equal(unlabelled.result.speakers, false, 'transcription succeeds without speaker labels when the speaker model is missing')
  assert.equal(unlabelled.result.speakerWarning, undefined)
  assert.equal(unlabelled.result.transcript, '[00:01] Hello there.')

  let installArgs
  runtime.transcriptionInstaller = async ({ args }) => { installArgs = args; await installSortformer(runtime); return { event: 'ready' } }
  const before = (await service.status()).diarization
  assert.equal(before.canInstall, true)
  assert.equal(before.canDiarize, false)
  const installed = await service.installDiarization()
  assert.equal(installed.modelState, 'ready')
  assert.deepEqual(installArgs.slice(0, 8), ['--task', 'diarization', '--model', PINNED_SORTFORMER.repository, '--revision', PINNED_SORTFORMER.revision, '--operation', 'install'])

  const order = []
  const progress = []
  runtime.transcriptionRunner = async ({ args, request, onEvent }) => {
    order.push(request.operation)
    assert.equal(args[args.indexOf('--task') + 1], request.operation === 'diarize' ? 'diarization' : 'transcription')
    if (request.operation === 'transcribe') {
      onEvent({ event: 'transcription-progress', id: request.id, percent: 99 })
      progress.push(service.active.get(session.id).progressPercent)
      return { id: request.id, text: 'Welcome to the review. Thanks for having me. Let us begin.', segments: MEETING_SEGMENTS }
    }
    assert.equal(service.active.get(session.id).progress, 'Identifying speakers locally…')
    assert.match(request.audioPath, /recording\.wav$/)
    onEvent({ event: 'transcription-progress', id: request.id, percent: 50 })
    progress.push(service.active.get(session.id).progressPercent)
    return { id: request.id, speakerSegments: MEETING_TURNS }
  }
  const completed = await service.transcribe(session.id, { retranscribe: true })
  assert.deepEqual(order, ['transcribe', 'diarize'], 'diarization runs although the session never opted in')
  assert.ok(progress[0] <= 85 && progress[1] > 85 && progress[1] <= 99)
  assert.equal(completed.result.transcript, [
    '**{{speaker1}}** [00:00]\nWelcome to the review.',
    '**{{speaker2}}** [00:04]\nThanks for having me.',
    '**{{speaker1}}** [00:08]\nLet us begin.',
  ].join('\n\n'))
  assert.equal(completed.result.speakers, true)
  assert.equal(completed.result.speakerCount, 2)
  assert.deepEqual(completed.result.speakerNumbers, [1, 2])
  assert.deepEqual((await runtime.transcriptionStorage.readResult(session.id)).speakerNumbers, [1, 2])
  assert.equal(completed.result.speakerWarning, undefined)
  assert.equal(completed.session.progressPercent, 100)
  assert.equal(completed.session.identifySpeakers, false)
  await service.close()
})

test('a failed speaker pass keeps the timestamped transcript and explains why; cancelling still cancels', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.diarizationModel = PINNED_SORTFORMER
  await installSortformer(runtime)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  let mode = 'fail'
  runtime.transcriptionRunner = async ({ request, signal }) => {
    if (request.operation === 'transcribe') return { id: request.id, text: 'Hello there.', segments: [{ start: 1, end: 2, text: 'Hello there.' }] }
    if (mode === 'fail') throw new Error('Sortformer ran out of memory.')
    if (mode === 'cancel') throw Object.assign(new Error('Transcription was cancelled.'), { code: 'TRANSCRIPTION_CANCELLED' })
    return { id: request.id, speakerSegments: [], signal }
  }
  const service = createTranscriptionService(runtime)
  const first = await recordedSession(runtime, service, { identifySpeakers: true })
  const completed = await service.transcribe(first.id)
  assert.equal(completed.session.state, 'ready')
  assert.equal(completed.result.transcript, '[00:01] Hello there.')
  assert.equal(completed.result.speakers, false)
  assert.match(completed.result.speakerWarning, /Speaker labels could not be added: Sortformer ran out of memory/)

  mode = 'empty'
  const empty = await recordedSession(runtime, service, { identifySpeakers: true })
  assert.match((await service.transcribe(empty.id)).result.speakerWarning, /No speaker turns/)

  mode = 'cancel'
  const cancelled = await recordedSession(runtime, service, { identifySpeakers: true })
  await assert.rejects(service.transcribe(cancelled.id), /cancelled/)
  const stored = await runtime.transcriptionStorage.readManifest(cancelled.id)
  assert.equal(stored.state, 'failed')
  assert.equal(stored.identifySpeakers, true, 'a retry reuses the saved choice')
  await service.close()
})

test('the speaker choice can change on idle and ready sessions but not while transcribing', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  runtime.transcriptionRunner = async ({ request }) => ({ id: request.id, text: 'Hi.', segments: [{ start: 0, end: 1, text: 'Hi.' }] })
  const service = createTranscriptionService(runtime)
  const session = await recordedSession(runtime, service)
  assert.equal((await service.updateOptions(session.id, { identifySpeakers: true })).identifySpeakers, true)
  assert.equal((await service.updateOptions(session.id, { identifySpeakers: false })).identifySpeakers, false)
  await service.transcribe(session.id)
  assert.equal((await service.updateOptions(session.id, { identifySpeakers: true })).identifySpeakers, true, 'a ready session may change the choice before a re-run')
  await assert.rejects(service.updateOptions('11111111-1111-4111-8111-111111111111', { identifySpeakers: true }), /not found/)
  await service.close()
})

test('Sortformer runs in its own model slot after Whisper has finished with its own', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.diarizationModel = PINNED_SORTFORMER
  await installSortformer(runtime)
  const activations = []
  runtime.mlxService = {
    selectedTranscriptionModel: async () => 'whisper',
    withModelActivity: async (id, operation) => { activations.push(id); return operation() },
  }
  runtime.transcriptionRunner = async ({ request }) => request.operation === 'transcribe'
    ? { id: request.id, text: 'Hi.', segments: [{ start: 0, end: 1, text: 'Hi.' }] }
    : { id: request.id, speakerSegments: [{ start: 0, end: 1, speaker: 0 }] }
  const service = createTranscriptionService(runtime)
  const completed = await service.transcribe((await recordedSession(runtime, service, { identifySpeakers: true })).id)
  assert.deepEqual(activations, ['whisper', 'sortformer'], 'Whisper finishes its slot before Sortformer starts')
  assert.equal(completed.result.transcript, '**{{speaker1}}** [00:00]\nHi.')
  await service.close()
})

test('re-transcribing a ready session replaces its result, and a plain process call still returns the existing one', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  let text = 'First pass.'
  let runs = 0
  runtime.transcriptionRunner = async ({ request }) => { runs += 1; return { id: request.id, text, segments: [{ start: 0, end: 1, text }] } }
  const service = createTranscriptionService(runtime)
  const session = await recordedSession(runtime, service)
  assert.equal((await service.transcribe(session.id)).result.transcript, '[00:00] First pass.')
  text = 'Second pass.'
  const unchanged = await service.transcribe(session.id)
  assert.equal(unchanged.result.transcript, '[00:00] First pass.')
  assert.equal(runs, 1)
  const redone = await service.transcribe(session.id, { retranscribe: true })
  assert.equal(runs, 2)
  assert.equal(redone.session.state, 'ready')
  assert.equal(redone.result.transcript, '[00:00] Second pass.')
  assert.equal((await runtime.transcriptionStorage.readResult(session.id)).transcript, '[00:00] Second pass.')
  await service.close()
})

test('a failed or cancelled re-transcription keeps the previous result and the ready state', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  let mode = 'ok'
  runtime.transcriptionRunner = async ({ request, signal }) => {
    if (mode === 'fail') throw new Error('Whisper crashed.')
    if (mode === 'cancel') {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      throw Object.assign(new Error('Transcription was cancelled.'), { code: 'TRANSCRIPTION_CANCELLED' })
    }
    return { id: request.id, text: 'Original.', segments: [{ start: 0, end: 1, text: 'Original.' }] }
  }
  const service = createTranscriptionService(runtime)
  const session = await recordedSession(runtime, service)
  await service.transcribe(session.id)
  mode = 'fail'
  await assert.rejects(service.transcribe(session.id, { retranscribe: true }), /Whisper crashed/)
  let manifest = await runtime.transcriptionStorage.readManifest(session.id)
  assert.equal(manifest.state, 'ready')
  assert.equal(manifest.error, null)
  assert.equal((await runtime.transcriptionStorage.readResult(session.id)).transcript, '[00:00] Original.')

  mode = 'cancel'
  const running = service.transcribe(session.id, { retranscribe: true })
  const rejection = assert.rejects(running, /cancelled/)
  while (!service.active.has(session.id)) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await runtime.transcriptionStorage.readManifest(session.id)).state, 'transcribing')
  await service.cancel(session.id)
  await rejection
  manifest = await runtime.transcriptionStorage.readManifest(session.id)
  assert.equal(manifest.state, 'ready')
  assert.equal((await runtime.transcriptionStorage.readResult(session.id)).transcript, '[00:00] Original.')
  await service.close()
})

test('re-transcription labels speakers when the model is installed and still rejects option changes while active', async (t) => {
  const { runtime } = await fixture(t)
  await installSnapshot(runtime)
  runtime.diarizationModel = PINNED_SORTFORMER
  await installSortformer(runtime)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let hold = false
  const operations = []
  runtime.transcriptionRunner = async ({ request }) => {
    operations.push(request.operation)
    if (request.operation === 'diarize') return { id: request.id, speakerSegments: MEETING_TURNS }
    if (hold) await gate
    return { id: request.id, text: 'Welcome to the review. Thanks for having me. Let us begin.', segments: MEETING_SEGMENTS }
  }
  const service = createTranscriptionService(runtime)
  const session = await recordedSession(runtime, service)
  const first = await service.transcribe(session.id)
  assert.equal(first.result.speakers, true, 'the session never opted in, yet speakers are identified')
  await service.updateOptions(session.id, { identifySpeakers: true })
  hold = true
  const running = service.transcribe(session.id, { retranscribe: true })
  while (!service.active.has(session.id)) await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(service.updateOptions(session.id, { identifySpeakers: false }), /while a transcription is running/)
  release()
  const redone = await running
  assert.deepEqual(operations, ['transcribe', 'diarize', 'transcribe', 'diarize'])
  assert.deepEqual(redone.result.speakerNumbers, [1, 2])
  assert.match(redone.result.transcript, /^\*\*\{\{speaker1\}\}\*\* \[00:00\]/)
  await service.close()
})

test('recovery restores an interrupted re-transcription to ready but fails a first-time one', async (t) => {
  const { runtime } = await fixture(t)
  runtime.mlxService = { selectedTranscriptionModel: async () => 'whisper' }
  const service = createTranscriptionService(runtime)
  const rerun = await recordedSession(runtime, service)
  await runtime.transcriptionStorage.writeResult(rerun.id, { transcript: '[00:00] Kept.', summary: '' })
  await runtime.transcriptionStorage.writeManifest({ ...rerun, state: 'transcribing' })
  const first = await recordedSession(runtime, service)
  await runtime.transcriptionStorage.writeManifest({ ...first, state: 'transcribing' })
  await service.recoverInterrupted()
  const restored = await runtime.transcriptionStorage.readManifest(rerun.id)
  assert.equal(restored.state, 'ready')
  assert.equal(restored.error, null)
  assert.equal((await runtime.transcriptionStorage.readResult(rerun.id)).transcript, '[00:00] Kept.')
  const failed = await runtime.transcriptionStorage.readManifest(first.id)
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /interrupted/)
  await service.close()
})

async function startApp(t, runtime, service) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  registerRoutes(app, { transcriptionService: service, transcriptionStorage: runtime.transcriptionStorage })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('recording playback supports ranges and speaker reassignment persists', async (t) => {
  const { runtime } = await fixture(t)
  const service = createTranscriptionService(runtime)
  t.after(() => service.close())
  const storage = runtime.transcriptionStorage
  const base = await startApp(t, runtime, service)
  const session = await storage.createSession({ fileName: 'meeting.mp3', audioExtension: '.mp3' })
  const audio = Buffer.from('0123456789abcdefghij')
  await storage.writeAudio(session.id, '.mp3', Readable.from([audio]))
  const ready = await storage.writeManifest({ ...session, state: 'ready' })

  const full = await fetch(`${base}/api/transcriptions/${session.id}/audio`)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'audio/mpeg')
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.equal(full.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), audio)

  const partial = await fetch(`${base}/api/transcriptions/${session.id}/audio`, { headers: { range: 'bytes=5-9' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), 'bytes 5-9/20')
  assert.equal(partial.headers.get('content-length'), '5')
  assert.equal(await partial.text(), '56789')
  assert.equal((await fetch(`${base}/api/transcriptions/${session.id}/audio`, { headers: { range: 'bytes=100-200' } })).status, 416)
  assert.equal((await fetch(`${base}/api/transcriptions/not-an-id/audio`)).status, 400)
  assert.equal((await fetch(`${base}/api/transcriptions/11111111-1111-4111-8111-111111111111/audio`)).status, 404)
  const bare = await storage.createSession({ fileName: 'x.wav' })
  assert.equal((await fetch(`${base}/api/transcriptions/${bare.id}/audio`)).status, 404)

  const post = (id, body) => fetch(`${base}/api/transcriptions/${id}/segments/speaker`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const mergeSpeakers = (id, body) => fetch(`${base}/api/transcriptions/${id}/speakers/merge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const renameSpeaker = (id, body) => fetch(`${base}/api/transcriptions/${id}/speakers/name`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await post(bare.id, { index: 0, speaker: 1 })).status, 404)
  assert.equal((await post(session.id, { index: 0, speaker: 1 })).status, 404)
  const segments = [
    { start: 0, end: 2, text: 'Hello.', speaker: 1 },
    { start: 2, end: 4, text: 'Hi.', speaker: 2 },
  ]
  await storage.writeResult(session.id, { ...buildTranscriptResult('Hello. Hi.', segments, [{ start: 0, end: 2, speaker: 0 }, { start: 2, end: 4, speaker: 1 }]), summary: 'sum' })
  const response = await post(session.id, { index: 1, speaker: 3 })
  assert.equal(response.status, 200)
  const { result } = await response.json()
  assert.deepEqual(result.speakerNumbers, [1, 3])
  assert.equal(result.summary, 'sum')
  assert.match(result.transcript, /\{\{speaker3\}\}/)
  assert.deepEqual((await storage.readResult(session.id)), result)
  assert.deepEqual((await (await fetch(`${base}/api/transcriptions/${session.id}`)).json()).result, result)

  const namedResponse = await renameSpeaker(session.id, { speaker: 3, name: '  Ola\nNord ' })
  assert.equal(namedResponse.status, 200)
  const namedResult = (await namedResponse.json()).result
  assert.deepEqual(namedResult.speakerNames, { '3': 'Ola Nord' })
  assert.deepEqual(await storage.readResult(session.id), namedResult)
  for (const body of [{ speaker: 2, name: 'Absent' }, { speaker: 3.5, name: 'Bad ID' }, { speaker: 3, name: null }]) {
    assert.equal((await renameSpeaker(session.id, body)).status, 400)
  }
  assert.deepEqual(await storage.readResult(session.id), namedResult)

  const mergedResponse = await mergeSpeakers(session.id, { source: 3, target: 1 })
  assert.equal(mergedResponse.status, 200)
  const merged = (await mergedResponse.json()).result
  assert.deepEqual(merged.segments.map((segment) => segment.speaker), [1, 1])
  assert.deepEqual(merged.speakerNumbers, [1])
  assert.equal(merged.summary, 'sum')
  assert.deepEqual(merged.speakerNames, { '1': 'Ola Nord' })
  assert.deepEqual(await storage.readResult(session.id), merged)
  for (const body of [{ source: 1, target: 1 }, { source: 1, target: 2 }, { source: '1', target: 2 }, { source: 0, target: 1 }]) {
    assert.equal((await mergeSpeakers(session.id, body)).status, 400)
  }

  assert.equal((await post(session.id, { index: 9, speaker: 1 })).status, 400)
  assert.equal((await post(session.id, { index: 0, speaker: 5 })).status, 400)
  assert.equal((await post(session.id, { index: 0, speaker: 0 })).status, 400)
  assert.equal((await post(session.id, { index: '0', speaker: 1 })).status, 400)
  assert.equal((await post('not-an-id', { index: 0, speaker: 1 })).status, 400)
  await storage.writeManifest({ ...ready, state: 'transcribing' })
  assert.equal((await post(session.id, { index: 0, speaker: 2 })).status, 409)
  assert.equal((await mergeSpeakers(session.id, { source: 1, target: 2 })).status, 409)
  assert.equal((await renameSpeaker(session.id, { speaker: 1, name: 'Blocked' })).status, 409)
})

test('segment split and merge routes persist and validate', async (t) => {
  const { runtime } = await fixture(t)
  const service = createTranscriptionService(runtime)
  t.after(() => service.close())
  const storage = runtime.transcriptionStorage
  const base = await startApp(t, runtime, service)
  const session = await storage.createSession({ fileName: 'meeting.mp3', audioExtension: '.mp3' })
  const ready = await storage.writeManifest({ ...session, state: 'ready' })
  const bare = await storage.createSession({ fileName: 'x.wav' })
  const post = (id, action, body) => fetch(`${base}/api/transcriptions/${id}/segments/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await post(bare.id, 'split', { index: 0, offset: 1 })).status, 404)
  assert.equal((await post(session.id, 'split', { index: 0, offset: 1 })).status, 404)
  assert.equal((await post(session.id, 'merge', { index: 1 })).status, 404)
  const segments = [
    { start: 0, end: 4, text: 'Hello there friend.', speaker: 1 },
    { start: 4, end: 6, text: 'Hi.', speaker: 2 },
  ]
  await storage.writeResult(session.id, { ...buildTranscriptResult('Hello there friend. Hi.', segments, [{ start: 0, end: 4, speaker: 0 }, { start: 4, end: 6, speaker: 1 }]), summary: 'sum' })

  const split = await post(session.id, 'split', { index: 0, offset: 6, speaker: 2 })
  assert.equal(split.status, 200)
  const { result } = await split.json()
  assert.deepEqual(result.segments.map((segment) => [segment.text, segment.speaker]), [['Hello', 1], ['there friend.', 2], ['Hi.', 2]])
  assert.equal(result.summary, 'sum')
  assert.deepEqual(await storage.readResult(session.id), result)

  const merge = await post(session.id, 'merge', { index: 1 })
  assert.equal(merge.status, 200)
  assert.deepEqual((await merge.json()).result.segments, segments)

  assert.equal((await post(session.id, 'split', { index: 0, offset: 3 })).status, 400)
  assert.equal((await post(session.id, 'split', { index: 0, offset: 6, speaker: 5 })).status, 400)
  assert.equal((await post(session.id, 'split', { index: 0, offset: '6' })).status, 400)
  assert.equal((await post(session.id, 'split', { index: 0, offset: 6, speaker: '2' })).status, 400)
  assert.equal((await post(session.id, 'merge', { index: 0 })).status, 400)
  assert.equal((await post(session.id, 'merge', { index: '1' })).status, 400)
  assert.equal((await post('not-an-id', 'split', { index: 0, offset: 6 })).status, 400)
  assert.equal((await post('not-an-id', 'merge', { index: 1 })).status, 400)
  await storage.writeManifest({ ...ready, state: 'transcribing' })
  assert.equal((await post(session.id, 'split', { index: 0, offset: 6 })).status, 409)
  assert.equal((await post(session.id, 'merge', { index: 1 })).status, 409)
})
