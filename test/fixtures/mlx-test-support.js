import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const fakeMlxHelperPath = path.resolve('test/fixtures/fake-mlx-helper.js')

export function emulateNativeMlxPlatform() {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')
  const release = os.release
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
  os.release = () => '23.0.0'
  return () => {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', arch)
    os.release = release
  }
}

export async function configureFakeMlx(t, {
  modelRoot,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-fake-mlx-'))
  const configuredModelRoot = modelRoot || path.join(root, 'models')
  const logPath = path.join(root, 'fake-helper.jsonl')
  const controlPath = path.join(root, 'fake-helper-control.json')
  const envKeys = ['FOLIO_MLX_HELPER', 'FOLIO_MODEL_ROOT', 'FOLIO_MLX_FIXTURE_LOG', 'FOLIO_MLX_FIXTURE_CONTROL', 'FOLIO_MLX_FIXTURE_INVALID_JSON', 'FOLIO_MLX_FIXTURE_FAIL_GENERATE']
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const restorePlatform = emulateNativeMlxPlatform()
  process.env.FOLIO_MLX_HELPER = fakeMlxHelperPath
  process.env.FOLIO_MODEL_ROOT = configuredModelRoot
  process.env.FOLIO_MLX_FIXTURE_LOG = logPath
  process.env.FOLIO_MLX_FIXTURE_CONTROL = controlPath
  delete process.env.FOLIO_MLX_FIXTURE_INVALID_JSON
  delete process.env.FOLIO_MLX_FIXTURE_FAIL_GENERATE
  await fs.mkdir(path.dirname(controlPath), { recursive: true })
  await fs.writeFile(controlPath, '{}')
  t.after(async () => {
    restorePlatform()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, modelRoot: configuredModelRoot, logPath, controlPath, helperPath: fakeMlxHelperPath, restorePlatform }
}

export async function readFakeMlxLog(logPath) {
  try {
    const content = await fs.readFile(logPath, 'utf8')
    return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

export async function writeFakeMlxControl(controlPath, state) {
  await fs.writeFile(controlPath, JSON.stringify(state))
}
