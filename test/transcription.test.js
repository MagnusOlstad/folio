import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import express from 'express'
import { createTranscriptionStorage } from '../server/transcription/storage.js'
import { createTranscriptionService, TRANSCRIPTION_MODEL } from '../server/transcription/service.js'
import { safeAudioFilename, safeTranscriptionId, splitTranscript } from '../server/transcription/model.js'
import { registerRoutes } from '../server/transcription/routes.js'

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

async function installSnapshot(runtime) {
  const directory = path.join(runtime.modelRoot, 'hf-cache', 'models--mlx-community--whisper-large-v3-turbo', 'snapshots', TRANSCRIPTION_MODEL.revision)
  await fs.mkdir(directory, { recursive: true })
  const files = {
    'config.json': JSON.stringify({ model_type: 'whisper', n_vocab: 51866 }),
    'weights.safetensors': 'weights',
    'tokenizer.json': '{}',
    'tokenizer_config.json': '{}',
    'special_tokens_map.json': '{}',
    'added_tokens.json': '{}',
    'vocab.json': '{}',
    'merges.txt': 'merge',
    'normalizer.json': '{}',
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
  await service.close()
})

test('Whisper status requires its model-specific snapshot and transcribes from its local directory', async (t) => {
  const { runtime } = await fixture(t)
  runtime.transcriptionInstaller = async ({ args }) => {
    assert.ok(args.includes('--revision'))
    assert.ok(args.includes(TRANSCRIPTION_MODEL.revision))
    assert.ok(!args.includes('--cache-directory'))
    await fs.mkdir(path.join(runtime.modelRoot, 'hf-cache', 'models--mlx-community--whisper-large-v3-turbo', 'snapshots', TRANSCRIPTION_MODEL.revision), { recursive: true })
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
  const directory = path.join(runtime.modelRoot, 'hf-cache', 'models--mlx-community--whisper-large-v3-turbo', 'snapshots', TRANSCRIPTION_MODEL.revision)
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

test('summary failure keeps edited transcript in local session storage', async (t) => {
  const { runtime } = await fixture(t)
  runtime.mlxService = { generate: async () => { throw new Error('no local text model') } }
  const service = createTranscriptionService(runtime)
  const session = await runtime.transcriptionStorage.createSession({ source: 'file', fileName: 'meeting.wav' })
  await runtime.transcriptionStorage.writeResult(session.id, { summary: 'Old summary', transcript: 'Old transcript' })
  await assert.rejects(service.summarize(session.id, 'Edited transcript with a corrected date.'), /Install and start a text generation model/)
  const saved = await runtime.transcriptionStorage.readResult(session.id)
  assert.equal(saved.transcript, 'Edited transcript with a corrected date.')
  assert.match(saved.markdown, /Edited transcript with a corrected date\./)
  await service.close()
})

test('cancelling summary generation retains the edited transcript and previous summary', async (t) => {
  const { runtime } = await fixture(t)
  let announceStarted
  let finishGeneration
  const started = new Promise((resolve) => { announceStarted = resolve })
  runtime.mlxService = { generate: () => new Promise((resolve) => { finishGeneration = resolve; announceStarted() }) }
  const service = createTranscriptionService(runtime)
  const session = await runtime.transcriptionStorage.createSession({ fileName: 'meeting.wav' })
  await runtime.transcriptionStorage.writeResult(session.id, { summary: 'Previous summary.', transcript: 'Previous transcript.' })
  const summarizing = service.summarize(session.id, 'Edited transcript, preserved even if cancelled.')
  await started
  const cancelling = service.cancelSummary(session.id)
  finishGeneration({ text: 'This result must be discarded.' })
  await assert.rejects(summarizing, /Summary cancelled/)
  assert.equal(await cancelling, true)
  const saved = await runtime.transcriptionStorage.readResult(session.id)
  assert.equal(saved.summary, 'Previous summary.')
  assert.equal(saved.transcript, 'Edited transcript, preserved even if cancelled.')
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
