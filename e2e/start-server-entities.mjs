import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { seedDataRoot } from './seed-data-root.mjs'
import { createRuntime } from '../server/app.js'
import { createMlxService } from '../server/mlx/service.js'
import { startServer } from '../server/index.js'

const root = await seedDataRoot()
const rootStatePath = path.join(os.tmpdir(), `folio-entities-e2e-root-${process.env.FOLIO_ENTITIES_E2E_PORT || '4174'}.json`)
await fs.writeFile(rootStatePath, JSON.stringify({ root }))
const bundleRoot = path.join(root, 'bundle')
await fs.writeFile(path.join(bundleRoot, 'entity-launch.md'), '---\ntitle: Acme launch\n---\nAcme met Priya Sharma to review Atlas.')
await fs.writeFile(path.join(bundleRoot, 'entity-followup.md'), '---\ntitle: Atlas follow-up\n---\nAcme shared an Atlas update with Priya Sharma.')
const modelRoot = path.join(root, 'entity-models')
const logPath = path.join(root, 'fake-helper.jsonl')
const controlPath = path.join(root, 'fake-helper-control.json')
await fs.writeFile(controlPath, '{}')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const arch = Object.getOwnPropertyDescriptor(process, 'arch')
const release = os.release
Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
os.release = () => '23.0.0'

const env = {
  ...process.env,
  FOLIO_DATA_ROOT: root,
  FOLIO_BUNDLE_ROOT: bundleRoot,
  FOLIO_MODEL_ROOT: modelRoot,
  FOLIO_MLX_HELPER: path.resolve('test/fixtures/fake-mlx-helper.js'),
  FOLIO_MLX_FIXTURE_LOG: logPath,
  FOLIO_MLX_FIXTURE_CONTROL: controlPath,
  PORT: process.env.FOLIO_ENTITIES_E2E_PORT || '4174',
}
const mlxService = createMlxService({
  projectRoot: path.resolve('.'), modelRoot, mlxHelperPath: env.FOLIO_MLX_HELPER,
  backgroundCooldownMs: 0,
  entitySnapshotValidator: async (cacheRoot, definition) => {
    const snapshot = path.join(cacheRoot, `models--${definition.repository.replaceAll('/', '--')}`, 'snapshots', definition.revision)
    try { await fs.access(path.join(snapshot, 'model.safetensors')); return snapshot } catch { return null }
  },
})
const runtime = createRuntime(env, mlxService)
const server = await startServer(Number(env.PORT), runtime)
console.log(`Entity E2E fixture root: ${root}`)
server.on('close', () => {
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', arch)
  os.release = release
  void fs.rm(rootStatePath, { force: true })
  void fs.rm(root, { recursive: true, force: true })
})
