import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const commit = '23ee03506a91ac3d3f0071b40e66a430eebdfa1d'
const cacheRoot = path.join(root, '.cache', `whisper.cpp-${commit}`)
const outputRoot = path.join(root, 'runtime', 'whisper.cpp')

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })
}

function commandAvailable(command) {
  return new Promise(resolve => {
    const child = spawn(command, ['--version'], { stdio: 'ignore', shell: false })
    child.once('error', () => resolve(false))
    child.once('close', code => resolve(code === 0))
  })
}

async function requireCommand(command, instructions) {
  if (!(await commandAvailable(command))) throw new Error(`${command} is required. ${instructions}`)
}

async function exists(filePath) {
  try { await fs.access(filePath); return true } catch { return false }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The bundled whisper runtime is currently prepared only on macOS arm64.')
}

await requireCommand('git', 'Install Xcode Command Line Tools with: xcode-select --install')
await requireCommand('cmake', 'Install CMake and Xcode Command Line Tools before running npm run desktop.')

if (!(await exists(path.join(cacheRoot, '.git')))) {
  await fs.mkdir(path.dirname(cacheRoot), { recursive: true })
  await run('git', ['clone', '--no-checkout', 'https://github.com/ggerganov/whisper.cpp.git', cacheRoot], root)
}
const pinnedCommitAvailable = await new Promise(resolve => {
  const child = spawn('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: cacheRoot, stdio: 'ignore', shell: false })
  child.once('error', () => resolve(false))
  child.once('close', code => resolve(code === 0))
})
if (!pinnedCommitAvailable) await run('git', ['fetch', '--depth', '1', 'origin', commit], cacheRoot)
await run('git', ['checkout', '--force', commit], cacheRoot)

const buildRoot = path.join(cacheRoot, 'build-arm64-metal')
await run('cmake', [
  '-S', cacheRoot,
  '-B', buildRoot,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_OSX_ARCHITECTURES=arm64',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_METAL=ON',
  '-DWHISPER_METAL_EMBED_LIBRARY=ON',
  '-DGGML_METAL_EMBED_LIBRARY=ON',
], root)
await run('cmake', ['--build', buildRoot, '--config', 'Release', '--target', 'whisper-cli', '--parallel'], root)

async function findExecutable() {
  const candidates = [
    path.join(buildRoot, 'bin', 'whisper-cli'),
    path.join(buildRoot, 'whisper-cli'),
  ]
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  throw new Error('Could not locate the built whisper-cli executable.')
}

await fs.mkdir(outputRoot, { recursive: true })
await fs.copyFile(await findExecutable(), path.join(outputRoot, 'whisper-cli'))
await fs.chmod(path.join(outputRoot, 'whisper-cli'), 0o755)
const metalResource = path.join(cacheRoot, 'ggml', 'src', 'ggml-metal', 'ggml-metal.metal')
if (!(await exists(metalResource))) throw new Error('The pinned whisper.cpp checkout has no Metal resource.')
await fs.copyFile(metalResource, path.join(outputRoot, 'ggml-metal.metal'))
await fs.copyFile(path.join(cacheRoot, 'LICENSE'), path.join(outputRoot, 'LICENSE'))

if (!fsSync.existsSync(path.join(outputRoot, 'whisper-cli'))) throw new Error('Whisper runtime output is missing.')
console.log(`Prepared whisper.cpp ${commit} at ${path.relative(root, outputRoot)}`)
