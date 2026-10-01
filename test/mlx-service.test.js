import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMlxService } from '../server/mlx/service.js'

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

async function fixture(t, { warmKeepAliveMs = 60_000 } = {}) {
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

test('models install explicitly into their pinned snapshots and use the JSONL worker protocol', async (t) => {
  const { root, logPath, service } = await fixture(t)
  const initial = await service.status()
  assert.equal(initial.available, true)
  assert.equal(initial.helperAvailable, true)
  assert.equal(initial.keepAliveMs, 60_000)
  assert.deepEqual(initial.models.map(({ id, name, downloadSizeBytes, installed, loaded, memory }) => ({ id, name, downloadSizeBytes, installed, loaded, memory })), [
    { id: 'gemma4', name: 'Gemma 4 E4B', downloadSizeBytes: 5_180_000_000, installed: false, loaded: false, memory: null },
    { id: 'embeddinggemma', name: 'EmbeddingGemma', downloadSizeBytes: 212_000_000, installed: false, loaded: false, memory: null },
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

test('deduplicates simultaneous launches for the same model', async (t) => {
  const { logPath, service } = await fixture(t)
  await Promise.all([service.install('gemma4'), service.install('gemma4')])
  const status = await service.status()
  assert.equal(status.models.find((model) => model.id === 'gemma4').installed, true)
  assert.equal(status.models.find((model) => model.id === 'gemma4').loaded, true)
  assert.equal((await readLog(logPath)).filter((entry) => entry.event === 'ready' && entry.model.includes('gemma-4')).length, 1)
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
