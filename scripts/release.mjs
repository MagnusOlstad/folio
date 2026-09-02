#!/usr/bin/env node
// Cuts a Folio release: bump version -> build the mac app -> tag -> publish to GitHub.
// Usage: npm run release -- patch|minor|major|<x.y.z> [--dry-run] [--allow-dirty] [--no-push]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = path.join(projectRoot, 'package.json')

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const bump = args.find((arg) => !arg.startsWith('--')) || 'patch'
const dryRun = flags.has('--dry-run')
const allowDirty = flags.has('--allow-dirty')
const push = !flags.has('--no-push')

if (!/^(patch|minor|major)$/.test(bump) && !/^\d+\.\d+\.\d+$/.test(bump)) {
  fail(`Unknown version bump "${bump}". Use patch, minor, major, or an explicit x.y.z.`)
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  // execFileSync returns null under stdio: 'ignore', so only trim captured output.
  const output = execFileSync(command, commandArgs, { cwd: projectRoot, encoding: 'utf8', ...options })
  return typeof output === 'string' ? output.trim() : ''
}

function step(command, commandArgs) {
  console.log(`  › ${command} ${commandArgs.join(' ')}`)
  if (dryRun) return ''
  return execFileSync(command, commandArgs, { cwd: projectRoot, stdio: 'inherit' })
}

function readVersion() {
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
}

// --- preflight -------------------------------------------------------------

try {
  run('gh', ['auth', 'status'], { stdio: 'ignore' })
} catch {
  fail('GitHub CLI is not authenticated. Run `gh auth login` first.')
}

if (!allowDirty && run('git', ['status', '--porcelain'])) {
  fail('Working tree is dirty. Commit or stash first, or pass --allow-dirty.')
}

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') console.warn(`  ! Releasing from "${branch}", not main.`)

const previousVersion = readVersion()
const previousTag = (() => {
  try {
    return run('git', ['describe', '--tags', '--abbrev=0'], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
})()

// --- bump ------------------------------------------------------------------

console.log(`\n  Folio release: ${previousVersion} → ${bump}\n`)
step('npm', ['version', bump, '--no-git-tag-version'])

const version = dryRun ? `<${bump}>` : readVersion()
const tag = `v${version}`

if (!dryRun) {
  try {
    run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { stdio: 'ignore' })
    restorePackageFiles()
    fail(`Tag ${tag} already exists.`)
  } catch (error) {
    if (error?.status === undefined) throw error
  }
}

function restorePackageFiles() {
  if (dryRun) return
  try {
    run('git', ['checkout', '--', 'package.json', 'package-lock.json'])
  } catch { /* nothing to restore */ }
}

// --- build -----------------------------------------------------------------

try {
  step('npm', ['run', 'dist:mac'])
} catch {
  restorePackageFiles()
  fail('Build failed. package.json was restored to the previous version.')
}

const releaseDir = path.join(projectRoot, 'release')
const artifacts = dryRun
  ? ['<dmg>', '<zip>']
  : fs.readdirSync(releaseDir)
      .filter((name) => name.includes(version) && /\.(dmg|zip)$/.test(name))
      .map((name) => path.join(releaseDir, name))

if (!dryRun && !artifacts.length) {
  restorePackageFiles()
  fail(`No .dmg or .zip for ${version} found in release/.`)
}

// --- tag + publish ---------------------------------------------------------

const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
const log = dryRun ? '' : run('git', ['log', range, '--pretty=format:- %s'])
const notes = [
  log || '- Maintenance release.',
  '',
  '## Install',
  '',
  `Download \`${path.basename(artifacts[0])}\`, drag Folio to Applications, then run once:`,
  '',
  '```sh',
  'xattr -dr com.apple.quarantine /Applications/Folio.app',
  '```',
  '',
  'This build is not code-signed, so macOS Gatekeeper needs that one-time nudge.',
].join('\n')

step('git', ['add', 'package.json', 'package-lock.json'])
step('git', ['commit', '-m', `release: ${tag}`])
step('git', ['tag', '-a', tag, '-m', `Folio ${tag}`])
if (push) {
  step('git', ['push', 'origin', branch])
  step('git', ['push', 'origin', tag])
}

const notesFile = path.join(projectRoot, 'release', 'NOTES.md')
if (!dryRun) fs.writeFileSync(notesFile, notes)

step('gh', [
  'release', 'create', tag,
  '--title', `Folio ${tag}`,
  '--notes-file', dryRun ? '<notes>' : notesFile,
  ...artifacts,
])

console.log(`\n  ✓ Released ${tag}\n`)
