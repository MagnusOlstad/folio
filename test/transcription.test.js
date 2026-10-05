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
import { TRANSCRIPTION_MODELS } from '../server/transcription/models.js'
import { safeAudioFilename, safeTranscriptionId, splitTranscript } from '../server/transcription/model.js'
import { registerRoutes } from '../server/transcription/routes.js'
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
    onEvent({ downloadedBytes: 75, totalBytes: 100 })
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
    assert.equal(sharedProgress?.downloadedBytes, 75)
    assert.equal(sharedProgress?.downloadPercent, 75)
    finishInstall()
    await installation
    const shared = await second.status()
    assert.equal(shared.modelState, 'ready')
    assert.equal(shared.canTranscribe, true)
    assert.equal(shared.installing, false)

    await mlxService.install('gemma4')
    await fs.writeFile(controlPath, JSON.stringify({ operationDelayMs: 10_000 }))
    const session = await first.createFileSession({ fileName: 'meeting.wav' })
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

test('summary generation returns a derived result without changing the raw session result', async (t) => {
  const { runtime } = await fixture(t)
  runtime.mlxService = { generate: async () => ({ text: 'Derived summary.' }) }
  const service = createTranscriptionService(runtime)
  const session = await runtime.transcriptionStorage.createSession({ fileName: 'meeting.wav' })
  const raw = { summary: 'Original summary.', transcript: 'Original transcript.' }
  await runtime.transcriptionStorage.writeResult(session.id, raw)

  const derived = await service.summarize(session.id, 'Edited draft transcript.')

  assert.equal(derived.summary, 'Derived summary.')
  assert.equal(derived.transcript, 'Edited draft transcript.')
  assert.deepEqual(await runtime.transcriptionStorage.readResult(session.id), raw)
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
  const summarizing = service.summarize(session.id, 'Edited transcript, preserved even if cancelled.')
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
