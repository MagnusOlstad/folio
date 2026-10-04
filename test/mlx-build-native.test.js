import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceExperiment = path.join(repositoryRoot, 'experiments', 'mlx-swift')

async function fixture(t, xcrunSource) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-mlx-build-'))
  const experiment = path.join(root, 'experiments', 'mlx-swift')
  const scripts = path.join(experiment, 'Scripts')
  const bin = path.join(root, 'bin')
  await fs.mkdir(scripts, { recursive: true })
  await fs.mkdir(bin)
  for (const filename of ['Package.swift', 'Package.resolved']) {
    await fs.copyFile(path.join(sourceExperiment, filename), path.join(experiment, filename))
  }
  for (const filename of ['build-native.sh', 'prepare-prebuilt-build.py']) {
    await fs.copyFile(path.join(sourceExperiment, 'Scripts', filename), path.join(scripts, filename))
  }

  await writeExecutable(bin, 'uname', '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) exit 1 ;; esac\n')
  await writeExecutable(bin, 'xcode-select', '#!/bin/sh\necho /Library/Developer/CommandLineTools\n')
  await writeExecutable(bin, 'python3', '#!/bin/sh\necho "$*" >> "$PYTHON_LOG"\nif [ "$1" = "-c" ]; then printf "%s\\n" "$3"; exit 0; fi\nexit 51\n')
  await writeExecutable(bin, 'xcrun', xcrunSource)
  const sideEffectLog = path.join(root, 'side-effects.log')
  const gitSource = `#!/bin/sh\necho "git $*" >> "${sideEffectLog}"\nexit 47\n`
  const curlSource = `#!/bin/sh\necho "curl $*" >> "${sideEffectLog}"\nexit 48\n`
  await writeExecutable(bin, 'git', gitSource)
  await writeExecutable(bin, 'curl', curlSource)
  for (const command of ['ditto', 'file', 'install_name_tool', 'lipo', 'otool', 'shasum']) {
    await writeExecutable(bin, command, '#!/bin/sh\nexit 0\n')
  }

  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, experiment, bin, sideEffectLog, pythonLog: path.join(root, 'python.log') }
}

async function writeExecutable(directory, name, contents) {
  const file = path.join(directory, name)
  await fs.writeFile(file, contents, { mode: 0o755 })
  await fs.chmod(file, 0o755)
}

const supportedSwiftStub = [
  'case "$*" in',
  '  "swift package --version") echo "Swift Package Manager - Swift 6.4.0"; exit 0 ;;',
  '  "swift --version") echo "Apple Swift version 6.4 (swiftlang-6.4.0.34.1)"; echo "Target: arm64-apple-macosx26.0"; exit 0 ;;',
  '  "swift build --build-system folio-probe") echo "Error: The value \'folio-probe\' is invalid for \'--build-system <build-system>\'. Please provide one of \'native\', \'swiftbuild\' or \'xcode\'." >&2; exit 64 ;;',
  'esac',
  'exit 49',
  '',
].join('\n')

function runBuild(fixtureData, env = {}) {
  return spawnSync('bash', [path.join(fixtureData.experiment, 'Scripts', 'build-native.sh')], {
    cwd: fixtureData.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixtureData.bin}${path.delimiter}${process.env.PATH}`,
      ...env,
    },
    timeout: 10_000,
  })
}

test('SwiftPM loader failure is diagnosed before creating cache or fetching sources', async (t) => {
  const fixtureData = await fixture(t, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$XCRUN_LOG"\necho "dyld: Symbol not found: _SourceKitInitializeBuildResponseData.encodeToLSPAny" >&2\nexit 1\n')
  const xcrunLog = path.join(fixtureData.root, 'xcrun.log')
  const result = runBuild(fixtureData, { XCRUN_LOG: xcrunLog, PYTHON_LOG: fixtureData.pythonLog, DEVELOPER_DIR: '' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SwiftPM preflight failed using xcrun-selected Swift/)
  assert.match(result.stderr, /Selected developer directory: \/Library\/Developer\/CommandLineTools/)
  assert.match(result.stderr, /Symbol not found|dyld/)
  assert.match(result.stderr, /Update or repair Command Line Tools|DEVELOPER_DIR=/)
  assert.equal((await fs.readFile(xcrunLog, 'utf8')).trim(), 'swift package --version')
  await assert.rejects(fs.access(path.join(fixtureData.experiment, '.cache')))
  await assert.rejects(fs.access(fixtureData.sideEffectLog))
  await assert.rejects(fs.access(fixtureData.pythonLog))
})

test('a missing per-command developer directory is reported before Python or downloads run', async (t) => {
  const fixtureData = await fixture(t, '#!/bin/sh\necho "xcrun: error: missing DEVELOPER_DIR path: $DEVELOPER_DIR" >&2\nexit 1\n')
  const missingDeveloperDir = path.join(fixtureData.root, 'Missing Xcode.app', 'Contents', 'Developer')
  const result = runBuild(fixtureData, { DEVELOPER_DIR: missingDeveloperDir, PYTHON_LOG: fixtureData.pythonLog })

  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes(`Selected developer directory: ${missingDeveloperDir}`))
  assert.match(result.stderr, /missing DEVELOPER_DIR path/)
  await assert.rejects(fs.access(path.join(fixtureData.experiment, '.cache')))
  await assert.rejects(fs.access(fixtureData.sideEffectLog))
  await assert.rejects(fs.access(fixtureData.pythonLog))
})

test('SwiftPM preflight preserves per-command developer directory and toolchain selection', async (t) => {
  const fixtureData = await fixture(t, `#!/bin/sh\nprintf "%s|%s|%s\\n" "\${DEVELOPER_DIR:-}" "\${TOOLCHAINS:-}" "$*" >> "$XCRUN_LOG"\n${supportedSwiftStub}`)
  const xcrunLog = path.join(fixtureData.root, 'xcrun.log')
  const selectedDeveloperDir = path.join(fixtureData.root, 'Full Xcode.app', 'Contents', 'Developer')
  const selectedToolchain = 'org.swift.custom-toolchain'
  const result = runBuild(fixtureData, {
    XCRUN_LOG: xcrunLog,
    PYTHON_LOG: fixtureData.pythonLog,
    DEVELOPER_DIR: selectedDeveloperDir,
    TOOLCHAINS: selectedToolchain,
  })

  assert.notEqual(result.status, 0)
  assert.deepEqual((await fs.readFile(xcrunLog, 'utf8')).trim().split('\n'), [
    `${selectedDeveloperDir}|${selectedToolchain}|swift package --version`,
    `${selectedDeveloperDir}|${selectedToolchain}|swift --version`,
    `${selectedDeveloperDir}|${selectedToolchain}|swift build --build-system folio-probe`,
  ])
  assert.match(result.stderr, /build-native: using Apple Swift version 6\.4 /)
  assert.match(await fs.readFile(fixtureData.sideEffectLog, 'utf8'), /^git clone /)
  assert.equal(await fs.stat(path.join(fixtureData.experiment, '.cache')).then((stat) => stat.isDirectory()), true)
})

test('toolchains without the swiftbuild backend fail preflight before fetching sources', async (t) => {
  const xcrunSource = [
    '#!/bin/sh',
    'case "$*" in',
    '  "swift package --version") echo "Swift Package Manager - Swift 6.0.3"; exit 0 ;;',
    '  "swift --version") echo "Apple Swift version 6.0.3 (swiftlang-6.0.3.1.10)"; exit 0 ;;',
    '  "swift build --build-system folio-probe") echo "Error: The value \'folio-probe\' is invalid for \'--build-system <build-system>\'. Please provide one of \'native\' or \'xcode\'." >&2; exit 64 ;;',
    'esac',
    'exit 49',
    '',
  ].join('\n')
  const fixtureData = await fixture(t, xcrunSource)
  const selectedDeveloperDir = path.join(fixtureData.root, 'Old Xcode.app', 'Contents', 'Developer')
  const result = runBuild(fixtureData, { DEVELOPER_DIR: selectedDeveloperDir, PYTHON_LOG: fixtureData.pythonLog })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not support --build-system swiftbuild/)
  assert.ok(result.stderr.includes(`developer directory: ${selectedDeveloperDir}, Apple Swift version 6.0.3`))
  await assert.rejects(fs.access(path.join(fixtureData.experiment, '.cache')))
  await assert.rejects(fs.access(fixtureData.sideEffectLog))
  await assert.rejects(fs.access(fixtureData.pythonLog))
})

test('the native build and its bin-path query share the swiftbuild backend arguments', async () => {
  const script = await fs.readFile(path.join(sourceExperiment, 'Scripts', 'build-native.sh'), 'utf8')
  const sharedArgs = script.match(/^swift_build_args=\((.*)\)$/m)

  assert.ok(sharedArgs, 'expected a shared swift_build_args array')
  assert.match(sharedArgs[1], /--build-system swiftbuild/)
  const buildInvocations = script.split('\n').filter((line) => /xcrun swift build (?!--build-system folio-probe)/.test(line))
  assert.deepEqual(buildInvocations, [
    'xcrun swift build "${swift_build_args[@]}"',
    'PRODUCTS_DIR="$(xcrun swift build "${swift_build_args[@]}" --show-bin-path)"',
  ])
})
