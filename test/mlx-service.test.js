import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { createMlxService } from '../server/mlx/service.js'
import { registerRoutes } from '../server/routes/mlx.js'

// A budget no worker fits in: every idle worker is evicted before the next one starts.
const TIGHT_MEMORY = { totalMemory: () => 1, reserveBytes: 0 }
const helperPath = path.resolve('test/fixtures/fake-mlx-helper.js')
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
const originalOsRelease = os.release

function setNativePlatform() {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  Object.defineProperty(process, 'arch', { ...originalArch, value: 'arm64' })
  os.release = () => '23.0.0'
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', originalPlatform)
  Object.defineProperty(process, 'arch', originalArch)
  os.release = originalOsRelease
}

async function fixture(t, { warmKeepAliveMs = 60_000, ...memoryOptions } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-mlx-test-'))
  const logPath = path.join(root, 'helper.jsonl')
  const previous = {
    FOLIO_MLX_FIXTURE_LOG: process.env.FOLIO_MLX_FIXTURE_LOG,
    FOLIO_MLX_FIXTURE_CONTROL: process.env.FOLIO_MLX_FIXTURE_CONTROL,
    FOLIO_MLX_FIXTURE_INVALID_JSON: process.env.FOLIO_MLX_FIXTURE_INVALID_JSON,
    FOLIO_MLX_FIXTURE_FAIL_GENERATE: process.env.FOLIO_MLX_FIXTURE_FAIL_GENERATE,
  }
  process.env.FOLIO_MLX_FIXTURE_LOG = logPath
  process.env.FOLIO_MLX_FIXTURE_CONTROL = path.join(root, 'control.json')
  delete process.env.FOLIO_MLX_FIXTURE_INVALID_JSON
  delete process.env.FOLIO_MLX_FIXTURE_FAIL_GENERATE
  await fs.writeFile(process.env.FOLIO_MLX_FIXTURE_CONTROL, '{}')
  setNativePlatform()
  const service = createMlxService({
    projectRoot: root,
    modelRoot: path.join(root, 'models'),
    mlxHelperPath: helperPath,
    warmKeepAliveMs,
    totalMemory: () => 1024 ** 4,
    readLevel: async () => null,
    ...memoryOptions,
  })
  t.after(async () => {
    await service.close()
    restorePlatform()
    await fs.rm(root, { recursive: true, force: true })
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  return { root, logPath, service }
}

async function readLog(logPath) {
  try {
    return (await fs.readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

async function setControl(root, state) {
  await fs.writeFile(path.join(root, 'control.json'), JSON.stringify(state))
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for MLX worker state.')
}

function assertProcessExited(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
}

test('models install explicitly into their pinned snapshots and use the JSONL worker protocol', async (t) => {
  const { root, logPath, service } = await fixture(t)
  const initial = await service.status()
  assert.equal(initial.available, true)
  assert.equal(initial.helperAvailable, true)
  assert.equal(initial.keepAliveMs, 60_000)
  assert.equal(initial.selectedGenerationModel, 'gemma4')
  assert.deepEqual(initial.models.map(({ id, purpose, downloadSizeBytes, selected }) => ({ id, purpose, downloadSizeBytes, selected })), [
    { id: 'gemma4', purpose: 'generation', downloadSizeBytes: 5_180_000_000, selected: true },
    { id: 'qwen35', purpose: 'generation', downloadSizeBytes: 3_060_000_000, selected: false },
    { id: 'llama32', purpose: 'generation', downloadSizeBytes: 1_810_000_000, selected: false },
    { id: 'embeddinggemma', purpose: 'embeddings', downloadSizeBytes: 212_000_000, selected: false },
    { id: 'lightonocr', purpose: 'ocr', downloadSizeBytes: 2_020_000_000, selected: false },
    { id: 'whisper', purpose: 'transcription', downloadSizeBytes: 1_610_000_000, selected: true },
    { id: 'whisperlarge', purpose: 'transcription', downloadSizeBytes: 3_090_000_000, selected: false },
    { id: 'sortformer', purpose: 'diarization', downloadSizeBytes: 236_110_000, selected: false },
  ])

  await assert.rejects(service.load('gemma4'), /not installed/)
  await assert.rejects(service.generate([{ role: 'user', content: 'hello' }]), /not installed/)
  assert.deepEqual(await readLog(logPath), [])

  const installed = await service.install('gemma4')
  const generation = service.modelDefinitions.gemma4
  assert.equal(generation.repository, 'mlx-community/gemma-4-e4b-it-4bit')
  assert.equal(generation.revision, '475b9088d29754a3379866cf5aeb6b41acd313c2')
  const snapshot = path.join(root, 'models', 'hf-cache', `models--${generation.repository.replaceAll('/', '--')}`, 'snapshots', generation.revision)
  assert.equal(installed.models.find((model) => model.id === 'gemma4').installed, true)
  assert.equal(installed.models.find((model) => model.id === 'gemma4').loaded, true)
  assert.deepEqual((await fs.readdir(snapshot)).sort(), ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json'])
  assert.equal(JSON.parse(await fs.readFile(path.join(snapshot, 'config.json'), 'utf8')).model_type, 'gemma4')

  const generated = await service.generate([{ role: 'user', content: 'Planning note\nA plan.' }])
  assert.deepEqual(JSON.parse(generated.text), {
    concept: { kind: 'note', path: ['planning'], title: 'Planning Note', type: 'Plan', description: 'Planning details that reference a future project.', tags: ['planlegging', 'økonomi'] },
  })
  assert.deepEqual(generated.memory, { activeBytes: 128_000_000, cacheBytes: 32_000_000, peakResidentBytes: 256_000_000 })

  const embeddingInstalled = await service.install('embeddinggemma')
  const embeddingDefinition = service.modelDefinitions.embeddinggemma
  assert.equal(embeddingDefinition.repository, 'mlx-community/embeddinggemma-300m-4bit')
  assert.equal(embeddingDefinition.revision, '5d9ef074df3957afc5c77127f208fddbc3c54187')
  const embeddingSnapshot = path.join(root, 'models', 'hf-cache', `models--${embeddingDefinition.repository.replaceAll('/', '--')}`, 'snapshots', embeddingDefinition.revision)
  assert.equal(embeddingInstalled.models.find((model) => model.id === 'embeddinggemma').installed, true)
  assert.deepEqual((await fs.readdir(embeddingSnapshot)).sort(), ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json'])
  const embedded = await service.embed(['first sentence', 'hidden constellation'])
  assert.deepEqual(embedded.embeddings, [[1, 0, 0], [0, 1, 0]])

  const calls = await readLog(logPath)
  const ready = calls.filter((entry) => entry.event === 'ready')
  assert.deepEqual(ready.map(({ task, model, revision, modelDirectory }) => ({ task, model, revision, modelDirectory })), [
    { task: 'generation', model: generation.repository, revision: generation.revision, modelDirectory: null },
    { task: 'embedding', model: embeddingDefinition.repository, revision: embeddingDefinition.revision, modelDirectory: null },
  ])
  assert.ok(calls.some((entry) => entry.event === 'request' && entry.operation === 'shutdown') === false)
  assert.ok(calls.some((entry) => entry.operation === 'generate' && entry.task === 'generation'))
  assert.ok(calls.some((entry) => entry.operation === 'embed' && entry.task === 'embedding'))

  await service.unload('gemma4')
  const unloaded = await service.status()
  assert.equal(unloaded.models.find((model) => model.id === 'gemma4').loaded, false)
  assert.equal(unloaded.models.find((model) => model.id === 'gemma4').memory, null)
  assert.equal((await readLog(logPath)).findLast((entry) => entry.event === 'response' && entry.operation === 'shutdown').memory.cacheBytes, 0)
})

test('download progress counts pinned snapshot files and ignores unrelated incomplete blobs', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await setControl(root, { readyDelayMs: 1_000 })
  const definition = service.modelDefinitions.qwen35
  const cacheRoot = path.join(root, 'models', 'hf-cache')
  const repoRoot = path.join(cacheRoot, `models--${definition.repository.replaceAll('/', '--')}`)
  const blobs = path.join(repoRoot, 'blobs')
  await fs.mkdir(blobs, { recursive: true })
  const incompleteBlob = path.join(blobs, 'resumed-download.incomplete')
  await fs.writeFile(incompleteBlob, Buffer.alloc(20))
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(incompleteBlob, old, old)
  const historicalSnapshot = path.join(repoRoot, 'snapshots', 'previous-revision')
  await fs.mkdir(historicalSnapshot, { recursive: true })
  await fs.writeFile(path.join(historicalSnapshot, 'stale-large-weight'), Buffer.alloc(5_000_000))
  const installation = service.install('qwen35')
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'ready' && entry.model?.includes('Qwen3.5')))

  const snapshot = path.join(repoRoot, 'snapshots', definition.revision)
  await fs.rm(path.join(snapshot, 'model.safetensors'))
  await fs.rm(path.join(snapshot, 'tokenizer_config.json'))
  await fs.mkdir(blobs, { recursive: true })
  const completeBlob = path.join(blobs, 'content-addressed-weight')
  await fs.writeFile(completeBlob, Buffer.alloc(100))
  await fs.symlink(completeBlob, path.join(snapshot, 'model.safetensors'))
  await fs.symlink(completeBlob, path.join(snapshot, 'duplicate-weight-link'))
  const first = (await service.status()).downloads.find(({ id }) => id === 'qwen35').progress
  const otherCachedBytes = (await Promise.all(['config.json', 'tokenizer.json'].map(async (name) => (
    (await fs.stat(path.join(snapshot, name))).size
  )))).reduce((total, bytes) => total + bytes, 0)
  assert.equal(first.phase, 'downloading')
  assert.equal(first.downloadedBytes, otherCachedBytes + 100, 'snapshot links are counted once while unrelated partial blobs are ignored')
  await fs.appendFile(incompleteBlob, Buffer.alloc(30))
  const next = (await service.status()).downloads.find(({ id }) => id === 'qwen35').progress
  assert.equal(next.downloadedBytes, first.downloadedBytes)
  assert.ok(next.percent >= first.percent && next.percent <= 99)

  await setControl(root, {})
  await installation
})

test('download progress includes native helper progress before cache files become visible', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await setControl(root, { readyDelayMs: 1_000, downloadProgress: { downloadedBytes: 500, totalBytes: 1_000 } })
  const installation = service.install('qwen35')
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'ready' && entry.model?.includes('Qwen3.5')))

  const definition = service.modelDefinitions.qwen35
  const snapshot = path.join(root, 'models', 'hf-cache', `models--${definition.repository.replaceAll('/', '--')}`, 'snapshots', definition.revision)
  await fs.rm(path.join(snapshot, 'model.safetensors'))
  await fs.rm(path.join(snapshot, 'tokenizer_config.json'))

  await waitUntil(async () => (await service.status()).downloads
    .find(({ id }) => id === 'qwen35').progress.downloadedBytes === 500)
  const progress = (await service.status()).downloads.find(({ id }) => id === 'qwen35').progress
  assert.equal(progress.downloadedBytes, 500)
  assert.equal(progress.totalBytes, 1_000)
  assert.equal(progress.percent, 50)
  assert.equal(progress.phase, 'downloading')
  await installation
})

test('aggregates model and tokenizer download stages without treating tokenizer bytes as the whole install', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await setControl(root, {
    readyDelayMs: 1_000,
    downloadProgressEvents: [
      { scope: 'model', downloadedBytes: 1_200_000_000, totalBytes: 1_600_000_000 },
      { scope: 'tokenizer', downloadedBytes: 2_000_000, totalBytes: 4_000_000 },
    ],
  })
  const installation = service.install('qwen35')
  await waitUntil(async () => (await readLog(logPath)).some(({ event }) => event === 'ready'))
  const definition = service.modelDefinitions.qwen35
  const snapshot = path.join(root, 'models', 'hf-cache', `models--${definition.repository.replaceAll('/', '--')}`, 'snapshots', definition.revision)
  await fs.rm(path.join(snapshot, 'model.safetensors'))
  await fs.rm(path.join(snapshot, 'tokenizer_config.json'))
  await waitUntil(async () => (await service.status()).downloads
    .find(({ id }) => id === 'qwen35')?.progress.totalBytes === 1_604_000_000)
  const progress = (await service.status()).downloads.find(({ id }) => id === 'qwen35').progress
  assert.equal(progress.totalBytes, 1_604_000_000)
  assert.equal(progress.downloadedBytes, 1_202_000_000)
  assert.equal(progress.percent, 74)
  await installation
})

test('idle workers expire after keep-alive and status includes current memory', async (t) => {
  const { service } = await fixture(t, { warmKeepAliveMs: 30 })
  await service.install('gemma4')
  assert.deepEqual((await service.status()).models.find((model) => model.id === 'gemma4').memory, {
    activeBytes: 128_000_000,
    cacheBytes: 32_000_000,
    peakResidentBytes: 256_000_000,
  })
  await waitUntil(async () => !(await service.status()).models.find((model) => model.id === 'gemma4').loaded)
  await service.install('gemma4')
  await waitUntil(async () => !(await service.status()).models.find((model) => model.id === 'gemma4').loaded)
})

test('propagates helper protocol errors and rejects invalid JSON readiness', async (t) => {
  const fixtureState = await fixture(t)
  await fixtureState.service.install('gemma4')
  await setControl(fixtureState.root, { failGenerate: true })
  await assert.rejects(fixtureState.service.generate([{ role: 'user', content: 'hello' }]), /fixture generation error/)

  await fixtureState.service.close()
  process.env.FOLIO_MLX_FIXTURE_INVALID_JSON = '1'
  const fresh = createMlxService({
    projectRoot: fixtureState.root,
    modelRoot: path.join(fixtureState.root, 'other-models'),
    mlxHelperPath: helperPath,
  })
  t.after(() => fresh.close())
  await assert.rejects(fresh.install('gemma4'), /invalid JSON/)
})

test('transcription progress is request scoped and never resolves the request, then unloads after success', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await setControl(root, { transcriptionProgress: [35, 12, 99, 100] })
  const whisper = service.modelDefinitions.whisper
  const snapshot = path.join(root, 'models', 'hf-cache', `models--${whisper.repository.replaceAll('/', '--')}`, 'snapshots', whisper.revision)
  await fs.mkdir(snapshot, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(snapshot, 'config.json'), JSON.stringify({ model_type: 'whisper' })),
    fs.writeFile(path.join(snapshot, 'model.safetensors'), 'fake weights'),
    fs.writeFile(path.join(snapshot, 'tokenizer.json'), '{}'),
    fs.writeFile(path.join(snapshot, 'tokenizer_config.json'), '{}'),
  ])
  assert.equal((await service.status()).models.find((model) => model.id === 'whisper').installed, true)
  await service.install('whisper')
  const progress = []
  const result = await service.transcribe('/tmp/recording.wav', { onProgress: (percent) => progress.push(percent) })
  assert.equal(result.text, 'Fixture transcription.')
  assert.deepEqual(progress, [35, 99])
  assert.equal((await service.status()).models.find((model) => model.id === 'whisper').loaded, false)
  assert.ok((await readLog(logPath)).some((entry) => entry.event === 'response' && entry.operation === 'shutdown'))

  const largeWhisper = service.modelDefinitions.whisperlarge
  const largeSnapshot = path.join(root, 'models', 'hf-cache', `models--${largeWhisper.repository.replaceAll('/', '--')}`, 'snapshots', largeWhisper.revision)
  await fs.mkdir(largeSnapshot, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(largeSnapshot, 'config.json'), JSON.stringify({ model_type: 'whisper' })),
    fs.writeFile(path.join(largeSnapshot, 'model.safetensors'), 'fake weights'),
    fs.writeFile(path.join(largeSnapshot, 'tokenizer.json'), '{}'),
    fs.writeFile(path.join(largeSnapshot, 'tokenizer_config.json'), '{}'),
  ])
  await service.selectTranscriptionModel('whisperlarge')
  await service.install('whisperlarge')
  const largeResult = await service.transcribe('/tmp/recording.wav', { onProgress: (percent) => progress.push(percent) })
  assert.equal(largeResult.text, 'Fixture transcription.')
  assert.equal((await service.status()).models.find((model) => model.id === 'whisperlarge').loaded, false)
})

test('Sortformer diarization uses its own worker with the diarize operation and unloads after each run', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await setControl(root, { transcriptionProgress: [40, 99] })
  await service.install('sortformer')
  assert.equal((await service.status()).models.find((model) => model.id === 'sortformer').purpose, 'diarization')
  const progress = []
  const result = await service.diarize('/tmp/recording.wav', { onProgress: (percent) => progress.push(percent) })
  assert.deepEqual(result.speakerSegments, [{ start: 0, end: 1.5, speaker: 0 }])
  assert.deepEqual(progress, [40, 99])
  assert.equal((await service.status()).models.find((model) => model.id === 'sortformer').loaded, false)
  assert.ok((await readLog(logPath)).some((entry) => entry.event === 'response' && entry.operation === 'diarize' && !entry.error))
  await assert.rejects(service.selectTranscriptionModel('sortformer'), /Choose a transcription model/)
})

test('transcription worker also unloads when inference fails and queued generation can proceed', async (t) => {
  const { root, service } = await fixture(t)
  const whisper = service.modelDefinitions.whisper
  const snapshot = path.join(root, 'models', 'hf-cache', `models--${whisper.repository.replaceAll('/', '--')}`, 'snapshots', whisper.revision)
  await fs.mkdir(snapshot, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(snapshot, 'config.json'), JSON.stringify({ model_type: 'whisper' })),
    fs.writeFile(path.join(snapshot, 'model.safetensors'), 'fake weights'),
    fs.writeFile(path.join(snapshot, 'tokenizer.json'), '{}'),
    fs.writeFile(path.join(snapshot, 'tokenizer_config.json'), '{}'),
  ])
  await setControl(root, { failTranscribe: true })
  await service.install('whisper')
  await assert.rejects(service.transcribe('/tmp/recording.wav'), /fixture transcription error/)
  assert.equal((await service.status()).models.find((model) => model.id === 'whisper').loaded, false)
  await service.install('gemma4')
  await service.generate([{ role: 'user', content: 'Queued after transcription.' }])
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, true)
})

test('cancelling active Whisper inference unloads its worker before queued work proceeds', async (t) => {
  const { root, logPath, service } = await fixture(t)
  const whisper = service.modelDefinitions.whisper
  const snapshot = path.join(root, 'models', 'hf-cache', `models--${whisper.repository.replaceAll('/', '--')}`, 'snapshots', whisper.revision)
  await fs.mkdir(snapshot, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(snapshot, 'config.json'), JSON.stringify({ model_type: 'whisper' })),
    fs.writeFile(path.join(snapshot, 'model.safetensors'), 'fake weights'),
    fs.writeFile(path.join(snapshot, 'tokenizer.json'), '{}'),
    fs.writeFile(path.join(snapshot, 'tokenizer_config.json'), '{}'),
  ])
  await service.install('whisper')
  await setControl(root, { operationDelayMs: 2_000 })
  const controller = new AbortController()
  const transcribing = service.transcribe('/tmp/recording.wav', { signal: controller.signal })
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'request' && entry.operation === 'transcribe'))
  controller.abort()
  await assert.rejects(transcribing, { code: 'TRANSCRIPTION_CANCELLED' })
  assert.equal((await service.status()).models.find((model) => model.id === 'whisper').loaded, false)
  await setControl(root, {})
  await service.install('gemma4')
  await service.generate([{ role: 'user', content: 'Queued after cancellation.' }])
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, true)
})

test('deduplicates simultaneous launches for the same model', async (t) => {
  const { logPath, service } = await fixture(t)
  await Promise.all([service.install('gemma4'), service.install('gemma4')])
  const status = await service.status()
  assert.equal(status.models.find((model) => model.id === 'gemma4').installed, true)
  assert.equal(status.models.find((model) => model.id === 'gemma4').loaded, true)
  assert.equal((await readLog(logPath)).filter((entry) => entry.event === 'ready' && entry.model.includes('gemma-4')).length, 1)
})

test('persists generation selection and consistently launches the selected model', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await service.install('gemma4')
  const selection = await service.selectGenerationModel('qwen35')
  assert.equal(selection.selectedGenerationModel, 'qwen35')
  assert.equal(selection.models.find((model) => model.id === 'qwen35').selected, true)
  assert.equal(selection.models.find((model) => model.id === 'gemma4').loaded, false)
  assert.ok((await readLog(logPath)).some((entry) => entry.event === 'request' && entry.operation === 'shutdown'))
  await service.install('qwen35')
  await service.generate([{ role: 'user', content: 'A planning note.' }])
  const qwenDefinition = service.modelDefinitions.qwen35
  assert.equal(qwenDefinition.revision, '0e7ffd5c629ef7719d4cbc04069232580bfa9d9c')
  assert.ok((await readLog(logPath)).some((entry) => entry.event === 'ready' && entry.model === qwenDefinition.repository))
  await service.close()

  const reopened = createMlxService({
    projectRoot: root,
    modelRoot: path.join(root, 'models'),
    mlxHelperPath: helperPath,
  })
  t.after(() => reopened.close())
  assert.equal((await reopened.status()).selectedGenerationModel, 'qwen35')
  assert.equal((await reopened.install('qwen35')).models.find((model) => model.id === 'qwen35').installed, true)
})

test('persists transcription selection separately and rejects models with another purpose', async (t) => {
  const { root, service } = await fixture(t)
  const defaultStatus = await service.status()
  assert.equal(defaultStatus.selectedTranscriptionModel, 'whisper')
  assert.equal(defaultStatus.models.find((model) => model.id === 'whisper').selected, true)
  assert.equal(defaultStatus.models.find((model) => model.id === 'whisperlarge').selected, false)

  const preferencePath = path.join(root, 'models', 'transcription-model.json')
  await fs.mkdir(path.dirname(preferencePath), { recursive: true })
  await fs.writeFile(preferencePath, '{broken')
  assert.equal((await service.status()).selectedTranscriptionModel, 'whisper')
  await fs.writeFile(preferencePath, JSON.stringify({ id: 'constructor' }))
  assert.equal((await service.status()).selectedTranscriptionModel, 'whisper')

  const selected = await service.selectTranscriptionModel('whisperlarge')
  assert.equal(selected.selectedTranscriptionModel, 'whisperlarge')
  assert.equal(selected.models.find((model) => model.id === 'whisperlarge').selected, true)
  assert.equal(selected.models.find((model) => model.id === 'whisperlarge').installed, false)
  assert.deepEqual(JSON.parse(await fs.readFile(preferencePath, 'utf8')), { id: 'whisperlarge' })
  await assert.rejects(service.selectTranscriptionModel('gemma4'), { statusCode: 400 })
  await service.close()

  const reopened = createMlxService({ projectRoot: root, modelRoot: path.join(root, 'models'), mlxHelperPath: helperPath })
  t.after(() => reopened.close())
  assert.equal((await reopened.status()).selectedTranscriptionModel, 'whisperlarge')
})

test('transcription selection route updates shared MLX status and rejects generation models', async (t) => {
  const { service } = await fixture(t)
  const app = express()
  app.use(express.json())
  registerRoutes(app, service, null)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  const selection = await fetch(`${base}/api/mlx/models/transcription-selection`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'whisperlarge' }),
  })
  assert.equal(selection.status, 200)
  assert.equal((await selection.json()).selectedTranscriptionModel, 'whisperlarge')
  const status = await fetch(`${base}/api/mlx/status`)
  assert.equal((await status.json()).models.find((model) => model.id === 'whisperlarge').selected, true)
  const rejected = await fetch(`${base}/api/mlx/models/transcription-selection`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'gemma4' }),
  })
  assert.equal(rejected.status, 400)
})

test('queues cache removal until active requests finish', async (t) => {
  const { root, service } = await fixture(t)
  await service.install('llama32')
  await setControl(root, { operationDelayMs: 80 })
  const generation = service.generate([{ role: 'user', content: 'Planning note.' }], { modelId: 'llama32' })
  await waitUntil(async () => (await readLog(path.join(root, 'helper.jsonl'))).some((entry) => entry.event === 'request' && entry.operation === 'generate'))
  const removal = service.remove('llama32')
  await generation
  await removal
  assert.equal((await service.status()).models.find((model) => model.id === 'llama32').installed, false)
  await assert.rejects(service.generate([{ role: 'user', content: 'Planning note.' }], { modelId: 'llama32' }), /not installed/)
})

test('waits for active embedding work before unload and removal', async (t) => {
  const { root, service } = await fixture(t)
  await service.install('embeddinggemma')
  await setControl(root, { operationDelayMs: 60 })
  const embedding = service.embed(['first sentence'])
  await waitUntil(async () => (await readLog(path.join(root, 'helper.jsonl'))).some((entry) => entry.event === 'request' && entry.operation === 'embed'))
  const removal = service.remove('embeddinggemma')
  await assert.rejects(service.embed(['second sentence']), /being removed/)
  await embedding
  await removal

  await service.install('embeddinggemma')
  const nextEmbedding = service.embed(['first sentence'])
  await waitUntil(async () => (await readLog(path.join(root, 'helper.jsonl'))).filter((entry) => entry.event === 'request' && entry.operation === 'embed').length === 2)
  const unloading = service.unload('embeddinggemma')
  await assert.rejects(service.embed(['third sentence']), /stopping/)
  await nextEmbedding
  await unloading
  assert.equal((await service.status()).models.find((model) => model.id === 'embeddinggemma').loaded, false)
})

test('serializes heavy operations globally and evicts idle heavy workers on a tight budget while embeddings coexist', async (t) => {
  const { root, logPath, service } = await fixture(t, TIGHT_MEMORY)
  const whisperDirectory = path.join(root, 'whisper-snapshot')
  await fs.mkdir(whisperDirectory, { recursive: true })
  for (const name of ['config.json', 'weights.safetensors', 'tokenizer.json', 'tokenizer_config.json',
    'special_tokens_map.json', 'added_tokens.json', 'vocab.json', 'merges.txt', 'normalizer.json']) {
    await fs.writeFile(path.join(whisperDirectory, name), name === 'config.json'
      ? JSON.stringify({ model_type: 'whisper', n_vocab: 51866 }) : 'fixture')
  }
  service.registerExternalModel('whisper', {
    snapshot: async () => whisperDirectory,
    status: async () => ({ installed: true, loading: false, progress: null }),
    install: async () => service.status(),
    remove: async () => service.status(),
  })

  await service.install('gemma4')
  const generationPid = (await readLog(logPath)).find((entry) => entry.event === 'ready' && entry.task === 'generation').pid
  const generation = service.generate([{ role: 'user', content: 'Planning note.' }])
  await generation
  await service.transcribe(path.join(root, 'meeting.wav'))
  assertProcessExited(generationPid)
  const whisperPid = (await readLog(logPath)).find((entry) => entry.event === 'ready' && entry.task === 'transcription').pid
  await service.generate([{ role: 'user', content: 'Planning note.' }])
  assertProcessExited(whisperPid)

  const lifecycle = (await readLog(logPath)).filter((entry) => entry.event === 'ready'
    || (entry.event === 'response' && entry.operation === 'shutdown'))
    .map((entry) => entry.event === 'ready' ? `ready:${entry.task}` : 'shutdown:worker')
  assert.deepEqual(lifecycle, [
    'ready:generation', 'shutdown:worker', 'ready:transcription', 'shutdown:worker', 'ready:generation',
  ])
  assert.deepEqual((await service.status()).models.find((model) => model.id === 'whisper'), {
    id: 'whisper', name: 'Whisper Large v3 Turbo', purpose: 'transcription', downloadSizeBytes: 1_610_000_000,
    downloadSizeIsEstimate: true, selected: true, installed: true, loaded: false, loading: false, busy: false,
    requestCount: 0, memory: null,
  })

  await setControl(root, { operationDelayMs: 80 })
  await service.install('embeddinggemma')
  const slowGeneration = service.generate([{ role: 'user', content: 'Planning note.' }])
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'request' && entry.operation === 'generate'))
  const embedding = service.embed(['first sentence'])
  await Promise.all([slowGeneration, embedding])
  const readyEvents = (await readLog(logPath)).filter((entry) => entry.event === 'ready')
  assert.ok(readyEvents.some((entry) => entry.task === 'embedding'))
})

test('switches between Turbo and full Whisper workers while preserving loaded generation and embedding workers', async (t) => {
  const { root, logPath, service } = await fixture(t)
  const snapshots = new Map()
  for (const id of ['whisper', 'whisperlarge']) {
    const definition = service.modelDefinitions[id]
    const directory = path.join(root, `${id}-snapshot`)
    await fs.mkdir(directory, { recursive: true })
    await Promise.all(definition.requiredFiles.map((name) => fs.writeFile(path.join(directory, name),
      name === 'config.json' ? JSON.stringify({ model_type: 'whisper', vocab_size: 51866 }) : 'fixture')))
    snapshots.set(id, directory)
    service.registerExternalModel(id, {
      snapshot: async () => directory,
      status: async () => ({ installed: true, loading: false, progress: null }),
    })
  }
  await service.install('gemma4')
  await service.install('embeddinggemma')
  await setControl(root, { operationDelayMs: 80 })
  const activeTranscription = service.transcribe(path.join(root, 'meeting.wav'))
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'request' && entry.operation === 'transcribe'))
  const selection = service.selectTranscriptionModel('whisperlarge')
  await activeTranscription
  await selection
  const turboReady = (await readLog(logPath)).find((entry) => entry.event === 'ready' && entry.task === 'transcription')
  assert.equal(turboReady.model, service.modelDefinitions.whisper.repository)

  await service.selectTranscriptionModel('whisperlarge')
  await service.transcribe(path.join(root, 'meeting.wav'))
  const fullReady = (await readLog(logPath)).findLast((entry) => entry.event === 'ready' && entry.task === 'transcription')
  assert.equal(fullReady.model, service.modelDefinitions.whisperlarge.repository)
  assert.equal(fullReady.revision, service.modelDefinitions.whisperlarge.revision)
  const lifecycle = await readLog(logPath)
  const turboResponseIndex = lifecycle.findIndex((entry) => entry.event === 'response' && entry.operation === 'transcribe')
  const turboShutdownIndex = lifecycle.findIndex((entry, index) => index > turboResponseIndex && entry.event === 'request' && entry.operation === 'shutdown')
  const fullReadyIndex = lifecycle.findIndex((entry) => entry.event === 'ready' && entry.model === fullReady.model)
  assert.ok(turboShutdownIndex > turboResponseIndex)
  assert.ok(fullReadyIndex > turboShutdownIndex)
  assertProcessExited(turboReady.pid)
  assert.equal((await service.status()).models.find((model) => model.id === 'embeddinggemma').loaded, true)

  await service.generate([{ role: 'user', content: 'Planning note.' }])
  assertProcessExited(fullReady.pid)
  const readyModels = (await readLog(logPath)).filter((entry) => entry.event === 'ready'
    && entry.task !== 'embedding').map((entry) => entry.model)
  assert.deepEqual(readyModels, [
    service.modelDefinitions.gemma4.repository,
    service.modelDefinitions.whisper.repository,
    service.modelDefinitions.whisperlarge.repository,
  ])
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, true)
  assert.equal(snapshots.size, 2)
})

test('queues heavy model loading behind in-flight generation without overlapping processes', async (t) => {
  const { root, logPath, service } = await fixture(t, TIGHT_MEMORY)
  await service.install('gemma4')
  await setControl(root, { operationDelayMs: 100 })
  const generation = service.generate([{ role: 'user', content: 'Planning note.' }])
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'request' && entry.operation === 'generate'))
  const loading = service.install('qwen35')
  const queuedStatus = await service.status()
  assert.equal(queuedStatus.models.find((model) => model.id === 'qwen35').busy, true)
  assert.equal(queuedStatus.models.find((model) => model.id === 'qwen35').requestCount, 0)
  await Promise.all([generation, loading])

  const events = (await readLog(logPath)).filter((entry) => entry.event === 'request' && entry.operation === 'shutdown'
    || entry.event === 'response' && entry.operation === 'generate'
    || entry.event === 'ready' && entry.task === 'generation')
  const generationResponses = events.filter((entry) => entry.event === 'response' && entry.operation === 'generate')
  const qwenReady = (await readLog(logPath)).findIndex((entry) => entry.event === 'ready' && entry.model?.includes('Qwen3.5'))
  const lastGenerationResponse = (await readLog(logPath)).findIndex((entry) => entry.event === 'response' && entry.operation === 'generate')
  const oldWorkerShutdown = (await readLog(logPath)).findIndex((entry) => entry.event === 'request' && entry.operation === 'shutdown')
  assert.equal(generationResponses.length, 1)
  assert.ok(oldWorkerShutdown > lastGenerationResponse)
  assert.ok(qwenReady > oldWorkerShutdown)
  const processes = await readLog(logPath)
  assertProcessExited(processes.find((entry) => entry.event === 'ready' && entry.model?.includes('gemma-4')).pid)
  process.kill(processes.find((entry) => entry.event === 'ready' && entry.model?.includes('Qwen3.5')).pid, 0)
  assert.equal((await service.status()).activeModel, 'qwen35')
})

test('cancels Whisper startup and waits for its process before the next heavy model starts', async (t) => {
  const { root, logPath, service } = await fixture(t, TIGHT_MEMORY)
  const whisperDirectory = path.join(root, 'whisper-snapshot')
  await fs.mkdir(whisperDirectory, { recursive: true })
  for (const name of ['config.json', 'weights.safetensors', 'tokenizer.json', 'tokenizer_config.json',
    'special_tokens_map.json', 'added_tokens.json', 'vocab.json', 'merges.txt', 'normalizer.json']) {
    await fs.writeFile(path.join(whisperDirectory, name), name === 'config.json'
      ? JSON.stringify({ model_type: 'whisper', n_vocab: 51866 }) : 'fixture')
  }
  service.registerExternalModel('whisper', {
    snapshot: async () => whisperDirectory,
    status: async () => ({ installed: true, loading: false }),
    install: async () => service.status(),
    remove: async () => service.status(),
  })
  await service.install('gemma4')
  await setControl(root, { readyDelayMs: 5_000 })
  const controller = new AbortController()
  const transcription = service.transcribe(path.join(root, 'meeting.wav'), { signal: controller.signal })
  const cancelled = assert.rejects(transcription, /cancelled/i)
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'ready' && entry.task === 'transcription'))
  controller.abort()
  await cancelled

  const whisperPid = (await readLog(logPath)).find((entry) => entry.event === 'ready' && entry.task === 'transcription').pid
  assertProcessExited(whisperPid)
  const whisperStatus = (await service.status()).models.find((model) => model.id === 'whisper')
  assert.equal(whisperStatus.loaded, false)
  await service.generate([{ role: 'user', content: 'Planning note.' }])
  const ready = (await readLog(logPath)).filter((entry) => entry.event === 'ready')
  assert.equal(ready.at(-1).task, 'generation')
})

test('keeps a worker alive while a model request overlaps the idle deadline', async (t) => {
  const { root, service } = await fixture(t, { warmKeepAliveMs: 35 })
  await service.install('gemma4')
  await setControl(root, { operationDelayMs: 90 })
  const result = await service.generate([{ role: 'user', content: 'Planning note\nA plan.' }])
  assert.match(result.text, /Planning Note/)
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, true)
})

test('rejects wrong-revision and incomplete snapshots without loading or downloading them', async (t) => {
  const { root, logPath, service } = await fixture(t)
  const definition = service.modelDefinitions.gemma4
  const cache = path.join(root, 'models', 'hf-cache', `models--${definition.repository.replaceAll('/', '--')}`, 'snapshots')
  const wrongSnapshot = path.join(cache, 'wrong-revision')
  await fs.mkdir(wrongSnapshot, { recursive: true })
  await Promise.all(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors'].map((file) => fs.writeFile(path.join(wrongSnapshot, file), '{}')))
  const partialSnapshot = path.join(cache, definition.revision)
  await fs.mkdir(partialSnapshot, { recursive: true })
  await fs.writeFile(path.join(partialSnapshot, 'config.json'), '{}')
  await fs.writeFile(path.join(partialSnapshot, 'tokenizer.json'), '{}')
  await fs.writeFile(path.join(partialSnapshot, 'tokenizer_config.json'), '{}')

  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').installed, false)
  await assert.rejects(service.load('gemma4'), /not installed/)
  await assert.rejects(service.generate([{ role: 'user', content: 'hello' }]), /not installed/)
  assert.deepEqual(await readLog(logPath), [])

  await service.install('gemma4')
  assert.deepEqual((await fs.readdir(partialSnapshot)).sort(), ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json'])
  assert.equal((await readLog(logPath)).filter((entry) => entry.event === 'ready').length, 1)
})

test('unloads workers that finish startup after unload was requested', async (t) => {
  const { root, service } = await fixture(t)
  await setControl(root, { readyDelayMs: 100 })
  const installing = service.install('gemma4')
  await waitUntil(async () => (await readLog(path.join(root, 'helper.jsonl'))).some((entry) => entry.event === 'ready'))
  const unloading = service.unload('gemma4')
  await installing
  await unloading
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, false)
})

test('close cancels an installation that is still starting', async (t) => {
  const { root, service } = await fixture(t)
  await setControl(root, { readyDelayMs: 100 })
  const installing = service.install('gemma4')
  await waitUntil(async () => (await readLog(path.join(root, 'helper.jsonl'))).some((entry) => entry.event === 'ready'))
  await service.close()
  await assert.rejects(installing, /SIGTERM/)
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, false)
})

test('request and shutdown failures clean up worker state', async (t) => {
  const { root, service } = await fixture(t)
  await setControl(root, {})
  await service.install('gemma4')
  await setControl(root, { exitOnOperation: 'generate', exitCode: 19 })
  await assert.rejects(service.generate([{ role: 'user', content: 'hello' }]), /stopped before replying/)
  await waitUntil(async () => !(await service.status()).models.find((model) => model.id === 'gemma4').loaded)

  await setControl(root, {})
  await service.install('gemma4')
  await setControl(root, { hangShutdown: true })
  await service.unload('gemma4')
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, false)

  await setControl(root, {})
  await service.install('gemma4')
  await setControl(root, { shutdownError: 'fixture shutdown error' })
  await service.unload('gemma4')
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, false)
  const failedShutdown = (await readLog(path.join(root, 'helper.jsonl')))
    .filter((entry) => entry.event === 'response' && entry.operation === 'shutdown').at(-1)
  assert.equal(failedShutdown.error, 'fixture shutdown error')
  assert.equal(failedShutdown.memory.cacheBytes, 0)
})

test('LightOnOCR installs, loads, extracts text, and evicts an idle generation worker on a tight budget', async (t) => {
  const { root, logPath, service } = await fixture(t, TIGHT_MEMORY)
  const definition = service.modelDefinitions.lightonocr
  assert.equal(definition.repository, 'lightonai/LightOnOCR-3-1B')
  assert.equal(definition.revision, '23d544085c886bbdace647bcfab91203299417e2')
  assert.equal(definition.task, 'ocr')

  await assert.rejects(service.extractText(path.join(root, 'scan.png')), (error) => {
    assert.equal(error.statusCode, 409)
    assert.equal(error.message, 'Install LightOnOCR in Settings → Models to extract text.')
    return true
  })
  await assert.rejects(service.load('lightonocr'), /not installed/)
  assert.deepEqual(await readLog(logPath), [])

  await service.install('gemma4')
  const generationPid = (await readLog(logPath)).find((entry) => entry.event === 'ready' && entry.task === 'generation').pid
  const installed = await service.install('lightonocr')
  assertProcessExited(generationPid)
  const model = installed.models.find((entry) => entry.id === 'lightonocr')
  assert.equal(model.installed, true)
  assert.equal(model.loaded, true)
  assert.equal(model.selected, false)
  assert.equal(installed.activeModel, 'lightonocr')
  assert.equal(installed.models.find((entry) => entry.id === 'gemma4').loaded, false)
  const snapshot = path.join(root, 'models', 'hf-cache', 'models--lightonai--LightOnOCR-3-1B', 'snapshots', definition.revision)
  assert.deepEqual((await fs.readdir(snapshot)).sort(), ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json'])

  const imagePath = path.join(root, 'scan.png')
  const result = await service.extractText(imagePath)
  assert.deepEqual(result, {
    text: '| Bank | Faktisk bankkonto i bank |', modelId: 'lightonocr',
    model: 'lightonai/LightOnOCR-3-1B', revision: definition.revision,
  })
  const calls = await readLog(logPath)
  assert.ok(calls.some((entry) => entry.operation === 'ocr' && entry.task === 'ocr' && entry.imagePath === imagePath))
  assert.equal((await service.status()).models.find((entry) => entry.id === 'lightonocr').loaded, true)

  await service.generate([{ role: 'user', content: 'Planning note.' }])
  const afterGeneration = await service.status()
  assert.equal(afterGeneration.models.find((entry) => entry.id === 'lightonocr').loaded, false)
  assert.equal(afterGeneration.models.find((entry) => entry.id === 'gemma4').loaded, true)

  await service.load('lightonocr')
  assert.equal((await service.status()).models.find((entry) => entry.id === 'gemma4').loaded, false)
  const unloaded = await service.unload('lightonocr')
  assert.equal(unloaded.models.find((entry) => entry.id === 'lightonocr').loaded, false)
  const removed = await service.remove('lightonocr')
  assert.equal(removed.models.find((entry) => entry.id === 'lightonocr').installed, false)
  await assert.rejects(service.extractText(imagePath), (error) => error.statusCode === 409)
})

test('LightOnOCR propagates helper errors and keeps the worker usable', async (t) => {
  const { root, service } = await fixture(t)
  await service.install('lightonocr')
  await setControl(root, { failOcr: true })
  await assert.rejects(service.extractText(path.join(root, 'scan.png')), /fixture ocr error/)
  await setControl(root, { ocrText: 'Korte renter' })
  assert.equal((await service.extractText(path.join(root, 'scan.png'))).text, 'Korte renter')
})

test('caption model selection defaults to none, persists, and is rejected for other models', async (t) => {
  const { root, service } = await fixture(t)
  assert.equal((await service.status()).selectedCaptionModel, null)
  assert.equal(await service.selectedCaptionModel(), null)
  const selected = await service.selectCaptionModel('qwen35')
  assert.equal(selected.selectedCaptionModel, 'qwen35')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'models', 'caption-model.json'), 'utf8')), { id: 'qwen35' })
  assert.deepEqual(selected.models.map((model) => model.id), (await service.status()).models.map((model) => model.id))
  assert.equal(selected.models.find((model) => model.id === 'qwen35').installed, false)
  await assert.rejects(service.selectCaptionModel('llama32'), (error) => error.statusCode === 400)
  await assert.rejects(service.selectCaptionModel('gemma4:caption'), (error) => error.statusCode === 400)
  const reopened = createMlxService({ projectRoot: root, modelRoot: path.join(root, 'models'), mlxHelperPath: helperPath })
  t.after(() => reopened.close())
  assert.equal(await reopened.selectedCaptionModel(), 'qwen35')
  assert.equal((await service.selectCaptionModel(null)).selectedCaptionModel, null)
})

test('captionImage reports missing selection and missing installs with 409 codes', async (t) => {
  const { root, logPath, service } = await fixture(t)
  const imagePath = path.join(root, 'photo.png')
  await assert.rejects(service.captionImage(imagePath), (error) => {
    assert.equal(error.statusCode, 409)
    assert.equal(error.code, 'CAPTION_MODEL_NOT_SELECTED')
    assert.equal(error.message, 'Choose a caption model in Settings → Models.')
    return true
  })
  await service.selectCaptionModel('qwen35')
  await assert.rejects(service.captionImage(imagePath), (error) => {
    assert.equal(error.statusCode, 409)
    assert.equal(error.code, 'CAPTION_MODEL_NOT_INSTALLED')
    assert.equal(error.modelId, 'qwen35')
    assert.equal(error.message, 'Install Qwen 3.5 4B (4-bit) in Settings → Models to describe images.')
    return true
  })
  assert.deepEqual(await readLog(logPath), [])
})

test('captions run in a caption-task worker that rolls up into the base model and swaps with its generation worker', async (t) => {
  const { root, logPath, service } = await fixture(t, TIGHT_MEMORY)
  await service.install('gemma4')
  await service.selectCaptionModel('gemma4')
  const generationPid = (await readLog(logPath)).find((entry) => entry.event === 'ready' && entry.task === 'generation').pid

  const imagePath = path.join(root, 'photo.png')
  const result = await service.captionImage(imagePath)
  assert.deepEqual(result, {
    text: 'A whiteboard with a roadmap.', modelId: 'gemma4',
    model: 'mlx-community/gemma-4-e4b-it-4bit', revision: service.modelDefinitions.gemma4.revision,
  })
  const calls = await readLog(logPath)
  const ready = calls.filter((entry) => entry.event === 'ready').at(-1)
  assert.equal(ready.task, 'caption')
  assert.equal(ready.model, 'mlx-community/gemma-4-e4b-it-4bit')
  assert.ok(ready.modelDirectory)
  assert.ok(calls.some((entry) => entry.operation === 'caption' && entry.task === 'caption' && entry.imagePath === imagePath))
  assertProcessExited(generationPid)

  const status = await service.status()
  assert.deepEqual(status.models.map((model) => model.id), ['gemma4', 'qwen35', 'llama32', 'embeddinggemma', 'lightonocr', 'whisper', 'whisperlarge', 'sortformer'])
  const gemma = status.models.find((model) => model.id === 'gemma4')
  assert.equal(gemma.loaded, true)
  assert.equal(gemma.busy, false)
  assert.deepEqual(gemma.memory, { activeBytes: 128_000_000, cacheBytes: 32_000_000, peakResidentBytes: 256_000_000 })
  assert.equal(status.activeModel, 'gemma4')

  // Generation takes the heavy slot back and stops the caption worker.
  const captionPid = ready.pid
  await service.generate([{ role: 'user', content: 'Planning note.' }])
  assertProcessExited(captionPid)
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, true)

  // OCR evicts a loaded caption worker as well.
  await service.captionImage(imagePath)
  const secondCaptionPid = (await readLog(logPath)).filter((entry) => entry.event === 'ready' && entry.task === 'caption').at(-1).pid
  await service.install('lightonocr')
  assertProcessExited(secondCaptionPid)
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').loaded, false)
})

test('caption requests mark the base model busy and removing the model stops its caption worker', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await service.install('gemma4')
  await service.selectCaptionModel('gemma4')
  await setControl(root, { operationDelayMs: 300 })
  const pending = service.captionImage(path.join(root, 'photo.png'))
  await waitUntil(async () => (await service.status()).models.find((model) => model.id === 'gemma4').requestCount === 1)
  assert.equal((await service.status()).models.find((model) => model.id === 'gemma4').busy, true)
  await pending
  await setControl(root, {})
  const captionPid = (await readLog(logPath)).filter((entry) => entry.event === 'ready' && entry.task === 'caption').at(-1).pid
  const removed = await service.remove('gemma4')
  assertProcessExited(captionPid)
  assert.equal(removed.models.find((model) => model.id === 'gemma4').installed, false)
  assert.equal(removed.models.find((model) => model.id === 'gemma4').loaded, false)
})

test('an idle caption worker unloads after its short timeout and helper errors keep it usable', async (t) => {
  const { root, logPath, service } = await fixture(t, { warmKeepAliveMs: 80 })
  await service.install('qwen35')
  await service.selectCaptionModel('qwen35')
  await setControl(root, { failCaption: true })
  await assert.rejects(service.captionImage(path.join(root, 'photo.png')), /fixture caption error/)
  await setControl(root, { captionText: 'A cat on a sofa.' })
  assert.equal((await service.captionImage(path.join(root, 'photo.png'))).text, 'A cat on a sofa.')
  const pid = (await readLog(logPath)).filter((entry) => entry.event === 'ready' && entry.task === 'caption').at(-1).pid
  await waitUntil(async () => (await service.status()).models.find((model) => model.id === 'qwen35').loaded === false, 3_000)
  assertProcessExited(pid)
})

test('caption selection route accepts models or null and rejects anything else', async (t) => {
  const { service } = await fixture(t)
  const app = express()
  app.use(express.json())
  registerRoutes(app, service, { registry: { get: () => null, list: () => [] } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const put = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/mlx/models/caption-selection`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const chosen = await put({ id: 'gemma4' })
  assert.equal(chosen.status, 200)
  assert.equal((await chosen.json()).selectedCaptionModel, 'gemma4')
  const cleared = await put({ id: null })
  assert.equal((await cleared.json()).selectedCaptionModel, null)
  for (const body of [{ id: 'llama32' }, { id: 'gemma4:caption' }, {}, { id: '' }]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body))
  }
})

const readyTasks = async (logPath) => (await readLog(logPath)).filter((entry) => entry.event === 'ready').map((entry) => entry.task)
const loadedIds = async (service) => (await service.status()).models.filter((model) => model.loaded).map((model) => model.id).sort()

test('idle workers unload after their per-purpose timeout and status reports the generation value', async (t) => {
  const { service } = await fixture(t, {
    warmKeepAliveMs: Infinity,
    idleUnloadOverrides: { generation: 400, embeddings: 120 },
  })
  assert.equal((await service.status()).keepAliveMs, 400)
  await service.install('gemma4')
  await service.install('embeddinggemma')
  await waitUntil(async () => !(await loadedIds(service)).includes('embeddinggemma'))
  assert.deepEqual(await loadedIds(service), ['gemma4'])
  await waitUntil(async () => (await loadedIds(service)).length === 0, 3_000)
})

test('warmKeepAliveMs caps the default idle timeouts', async (t) => {
  const { service } = await fixture(t, { warmKeepAliveMs: 45 })
  assert.equal((await service.status()).keepAliveMs, 45)
})

test('admission evicts the least recently used idle worker before a heavy model starts', async (t) => {
  const { logPath, service } = await fixture(t, { totalMemory: () => 6.4e9, reserveBytes: 0 })
  await service.install('embeddinggemma')
  assert.deepEqual(await loadedIds(service), ['embeddinggemma'])
  await service.install('gemma4')
  assert.deepEqual(await loadedIds(service), ['gemma4'])
  assert.deepEqual(await readyTasks(logPath), ['embedding', 'generation'])
})

test('admission never stops a busy worker and still starts the heavy model', async (t) => {
  const { root, logPath, service } = await fixture(t, { totalMemory: () => 6.4e9, reserveBytes: 0 })
  await service.install('embeddinggemma')
  await setControl(root, { operationDelayMs: 150 })
  const embedding = service.embed(['busy sentence'])
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'request' && entry.operation === 'embed'))
  await service.install('gemma4')
  assert.deepEqual(await loadedIds(service), ['embeddinggemma', 'gemma4'])
  await embedding
})

test('the pressure monitor stops idle workers under low memory and leaves busy ones', async (t) => {
  let level = 80
  const { root, logPath, service } = await fixture(t, { readLevel: async () => level, pressureIntervalMs: 30 })
  await service.install('embeddinggemma')
  await service.install('gemma4')
  await waitUntil(async () => (await readyTasks(logPath)).length === 2)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.deepEqual(await loadedIds(service), ['embeddinggemma', 'gemma4'])
  await setControl(root, { operationDelayMs: 400 })
  const busy = service.generate([{ role: 'user', content: 'Planning note.' }])
  await waitUntil(async () => (await readLog(logPath)).some((entry) => entry.event === 'request' && entry.operation === 'generate'))
  level = 5
  await waitUntil(async () => !(await loadedIds(service)).includes('embeddinggemma'))
  assert.deepEqual(await loadedIds(service), ['gemma4'])
  await busy
  await waitUntil(async () => (await loadedIds(service)).length === 0)
})

test('the pressure monitor only polls while workers are loaded and stops on close', async (t) => {
  let reads = 0
  const { service } = await fixture(t, {
    readLevel: async () => { reads += 1; return 90 }, pressureIntervalMs: 20,
    idleUnloadOverrides: { embeddings: 60 },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(reads, 0)
  await service.install('embeddinggemma')
  await waitUntil(() => reads > 0)
  await waitUntil(async () => (await loadedIds(service)).length === 0)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const settled = reads
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(reads, settled)
  await service.install('embeddinggemma')
  await service.close()
  const afterClose = reads
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(reads, afterClose)
})

test('with ample memory a Qwen caption worker and a Gemma generation worker stay loaded together', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await service.install('qwen35')
  await service.unload('qwen35')
  await service.install('gemma4')
  await service.selectCaptionModel('qwen35')
  await service.captionImage(path.join(root, 'photo.png'))
  assert.deepEqual(await loadedIds(service), ['gemma4', 'qwen35'])
  const ready = (await readLog(logPath)).filter((entry) => entry.event === 'ready')
  assert.equal(ready.length, 3)
  await service.generate([{ role: 'user', content: 'Planning note.' }])
  await service.captionImage(path.join(root, 'photo.png'))
  assert.equal((await readLog(logPath)).filter((entry) => entry.event === 'ready').length, 3)
  for (const { pid } of ready.slice(1)) process.kill(pid, 0)
  assert.equal((await service.status()).activeModel, 'qwen35')
})

test('with little memory starting one heavy worker stops the least recently used idle other', async (t) => {
  // Budget 3.7 GB: the Qwen caption worker (3.06 GB download plus headroom) does not fit next to Gemma.
  const { root, logPath, service } = await fixture(t, { totalMemory: () => 3.7e9, reserveBytes: 0 })
  await service.install('qwen35')
  await service.unload('qwen35')
  await service.install('gemma4')
  assert.deepEqual(await loadedIds(service), ['gemma4'])
  const gemmaPid = (await readLog(logPath)).findLast((entry) => entry.event === 'ready' && entry.task === 'generation').pid
  await service.selectCaptionModel('qwen35')
  await service.captionImage(path.join(root, 'photo.png'))
  assert.deepEqual(await loadedIds(service), ['qwen35'])
  assertProcessExited(gemmaPid)
  assert.equal((await service.status()).activeModel, 'qwen35')
})

test('a model and its caption worker never stay loaded together, in either direction', async (t) => {
  const { root, logPath, service } = await fixture(t)
  await service.install('gemma4')
  await service.selectCaptionModel('gemma4')
  const generationPid = (await readLog(logPath)).find((entry) => entry.event === 'ready' && entry.task === 'generation').pid
  await service.captionImage(path.join(root, 'photo.png'))
  assertProcessExited(generationPid)
  const captionPid = (await readLog(logPath)).findLast((entry) => entry.event === 'ready' && entry.task === 'caption').pid
  await service.generate([{ role: 'user', content: 'Planning note.' }])
  assertProcessExited(captionPid)
  assert.deepEqual(await loadedIds(service), ['gemma4'])
  assert.equal((await service.status()).activeModel, 'gemma4')
})
