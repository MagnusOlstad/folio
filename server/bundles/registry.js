import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

const REGISTRY_VERSION = 1
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/

function idForPath(markdownPath) {
  return `bundle-${crypto.createHash('sha256').update(markdownPath).digest('hex').slice(0, 16)}`
}

function isWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid bundle registry entry.')
  const id = String(entry.id || '')
  const rawPath = String(entry.markdownPath || '').trim()
  if (!rawPath) throw new Error('Bundle registry entry is missing markdownPath.')
  const markdownPath = path.resolve(rawPath)
  const name = String(entry.name || '').trim()
  if (!ID_PATTERN.test(id) || !name || !markdownPath) throw new Error('Invalid bundle registry entry.')
  return {
    id,
    name: name.slice(0, 120),
    markdownPath,
    managed: entry.managed === true,
    detached: entry.detached === true,
  }
}

function validateEntries(entries) {
  const normalized = entries.map(normalizeEntry)
  const ids = new Set()
  for (const entry of normalized) {
    if (ids.has(entry.id)) throw new Error('Bundle registry contains duplicate IDs.')
    ids.add(entry.id)
  }
  for (let index = 0; index < normalized.length; index += 1) {
    for (let other = index + 1; other < normalized.length; other += 1) {
      const left = normalized[index].markdownPath
      const right = normalized[other].markdownPath
      if (isWithin(left, right) || isWithin(right, left)) throw new Error('Bundle registry contains overlapping paths.')
    }
  }
  return normalized
}

async function pathExists(directory) {
  try {
    await fs.access(directory)
    return true
  } catch {
    return false
  }
}

async function legacyEntryFor(config) {
  const legacyPath = path.resolve(path.join(config.dataRoot, 'bundle'))
  const legacyPaths = [legacyPath, path.join(config.dataRoot, 'drafts'), path.join(config.dataRoot, 'search-index.json'), path.join(config.dataRoot, 'imports')]
  if (!(await Promise.all(legacyPaths.map(pathExists))).some(Boolean)) return null
  return {
    id: 'legacy-bundle',
    name: 'Folio bundle',
    markdownPath: legacyPath,
    managed: false,
    detached: false,
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await fs.rename(temporaryPath, filePath)
}

export function createBundleRegistry(config) {
  const registryPath = path.join(config.dataRoot, 'bundles.json')
  let registryError = null
  let entries = []

  async function read() {
    registryError = null
    try {
      const parsed = JSON.parse(await fs.readFile(registryPath, 'utf8'))
      if (!parsed || parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.bundles)) throw new Error('Invalid bundle registry.')
      entries = validateEntries(parsed.bundles)
      return entries
    } catch (error) {
      if (error.code !== 'ENOENT') {
        registryError = error instanceof Error ? error.message : 'Invalid bundle registry.'
        const legacy = await legacyEntryFor(config)
        if (legacy) entries = [legacy]
        return entries
      }
      const legacy = await legacyEntryFor(config)
      if (!legacy) return entries
      entries = [legacy]
      await writeJsonAtomic(registryPath, { version: REGISTRY_VERSION, bundles: entries })
      return entries
    }
  }

  async function write(nextEntries) {
    if (registryError) throw new Error(`Bundle registry is invalid and cannot be changed: ${registryError}`)
    entries = validateEntries(nextEntries)
    await writeJsonAtomic(registryPath, { version: REGISTRY_VERSION, bundles: entries })
    return entries
  }

  function publicEntry(entry) {
    return { ...entry }
  }

  async function setup({ name, markdownPath, managed = false, source = 'empty' } = {}) {
    if (registryError) throw new Error(`Bundle registry is invalid and cannot be changed: ${registryError}`)
    const requestedName = String(name || '').trim().slice(0, 120)
    if (!requestedName) throw new Error('Bundle name is required.')
    let requestedPath = path.resolve(String(markdownPath || path.join(config.dataRoot, 'bundles', requestedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bundle')))
    try {
      requestedPath = await fs.realpath(requestedPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (source !== 'existing') await fs.mkdir(path.dirname(requestedPath), { recursive: true })
      const parent = await fs.realpath(path.dirname(requestedPath))
      requestedPath = path.join(parent, path.basename(requestedPath))
    }
    const existing = entries.find((entry) => entry.markdownPath === requestedPath)
    if (existing) {
      if (existing.detached) {
        existing.detached = false
        existing.name = requestedName
        await write(entries)
      }
      return publicEntry(existing)
    }
    if (entries.some((entry) => isWithin(entry.markdownPath, requestedPath) || isWithin(requestedPath, entry.markdownPath))) throw new Error('Bundle path overlaps an existing bundle.')
    if (managed) {
      const managedRoot = await fs.realpath(path.resolve(config.dataRoot, 'bundles')).catch(() => path.resolve(config.dataRoot, 'bundles'))
      if (!isWithin(managedRoot, requestedPath)) throw new Error('Managed bundles must be inside the Folio bundles folder.')
    }
    if (source === 'existing' || source === 'obsidian') {
      const stat = await fs.stat(requestedPath).catch(() => null)
      if (!stat?.isDirectory()) throw new Error('Select an existing Markdown folder.')
    } else {
      await fs.mkdir(requestedPath, { recursive: true })
    }
    const entry = {
      id: idForPath(requestedPath),
      name: requestedName,
      markdownPath: requestedPath,
      managed: managed === true,
      detached: false,
    }
    await write([...entries, entry])
    return publicEntry(entry)
  }

  async function rename(id, name) {
    if (registryError) throw new Error(`Bundle registry is invalid and cannot be changed: ${registryError}`)
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error('Bundle not found.')
    const nextName = String(name || '').trim().slice(0, 120)
    if (!nextName) throw new Error('Bundle name is required.')
    entry.name = nextName
    await write(entries)
    return publicEntry(entry)
  }

  async function detach(id) {
    if (registryError) throw new Error(`Bundle registry is invalid and cannot be changed: ${registryError}`)
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error('Bundle not found.')
    entry.detached = true
    await write(entries)
    return publicEntry(entry)
  }

  return {
    registryPath,
    read,
    write,
    setup,
    rename,
    detach,
    list: () => entries.filter((entry) => !entry.detached).map(publicEntry),
    all: () => entries.map(publicEntry),
    get: (id) => entries.find((entry) => entry.id === id && !entry.detached) || null,
    getError: () => registryError,
    assertMutable: () => {
      if (registryError) throw new Error(`Bundle registry is invalid and cannot be changed: ${registryError}`)
    },
    pathForId: (id) => entries.find((entry) => entry.id === id)?.markdownPath || null,
  }
}

export function createBundleRuntimeManager({ config, defaultRuntime, createRuntimeForBundle }) {
  const registry = createBundleRegistry(config)
  const runtimes = new Map()
  const preparations = new Map()
  const contexts = new AsyncLocalStorage()
  const pendingContext = Symbol('pending-bundle')
  const pendingRoot = path.join(config.dataRoot, 'state', 'pending-import')
  const pendingRuntime = createRuntimeForBundle({
    ...config,
    dataRoot: path.join(config.dataRoot, 'state', 'pending-import'),
    bundleRoot: path.join(pendingRoot, 'bundle'),
    rawRoot: path.join(pendingRoot, 'raw'),
    draftsRoot: path.join(pendingRoot, 'drafts'),
    importsRoot: path.join(pendingRoot, 'imports'),
    indexPath: path.join(pendingRoot, 'search-index.json'),
  })

  function runtimeFor(entry) {
    if (!entry) return defaultRuntime
    if (!runtimes.has(entry.id)) {
      const bundleConfig = {
        ...config,
        bundleRoot: entry.markdownPath,
        rawRoot: path.join(entry.markdownPath, 'references', 'inbox'),
        draftsRoot: path.join(config.dataRoot, 'state', 'bundles', entry.id, 'drafts'),
        importsRoot: path.join(config.dataRoot, 'state', 'bundles', entry.id, 'imports'),
        indexPath: path.join(config.dataRoot, 'state', 'bundles', entry.id, 'search-index.json'),
      }
      const runtime = (entry.id === 'legacy-bundle' && entry.markdownPath === config.bundleRoot)
        ? defaultRuntime
        : createRuntimeForBundle(bundleConfig)
      runtimes.set(entry.id, runtime)
    }
    return runtimes.get(entry.id)
  }

  function activeRuntime() {
    return contexts.getStore() === pendingContext ? pendingRuntime : runtimeFor(contexts.getStore())
  }

  function prepare(entry) {
    const runtime = runtimeFor(entry)
    if (!entry && preparations.has('legacy-fallback')) return preparations.get('legacy-fallback')
    if (entry && runtime === defaultRuntime) return Promise.resolve(runtime)
    const key = entry?.id || 'legacy-fallback'
    if (!preparations.has(key)) {
      preparations.set(key, Promise.all([
        fs.mkdir(runtime.rawRoot, { recursive: true }),
        fs.mkdir(runtime.draftsRoot, { recursive: true }),
        fs.mkdir(runtime.importsRoot, { recursive: true }),
      ]).then(async () => {
        await runtime.reindexBundle()
        void runtime.refreshMissingEmbeddingsInBackground()
        return runtime
      }))
    }
    return preparations.get(key)
  }

  function preparePending() {
    if (!preparations.has('pending-import')) {
      preparations.set('pending-import', Promise.all([
        fs.mkdir(pendingRuntime.bundleRoot, { recursive: true }),
        fs.mkdir(pendingRuntime.importsRoot, { recursive: true }),
      ]).then(() => pendingRuntime))
    }
    return preparations.get('pending-import')
  }

  function proxyRuntime() {
    return new Proxy(defaultRuntime, {
      get(_target, property) {
        if (property === 'getBundleRoot') return () => activeRuntime().bundleRoot
        if (property === 'getRawRoot') return () => activeRuntime().rawRoot
        const propertyName = String(property)
        const defaultValue = Reflect.get(defaultRuntime, property, defaultRuntime)
        if (typeof defaultValue !== 'function') return defaultValue
        return (...args) => {
          const runtime = activeRuntime()
          const value = Reflect.get(runtime, property, runtime)
          if (typeof value !== 'function') return value
          if (!['startObsidianImport', 'getObsidianImportJob', 'cancelObsidianImport'].includes(propertyName))
            return value.apply(runtime, args)
          return Promise.resolve(value.apply(runtime, args)).catch(async (error) => {
            const message = error instanceof Error ? error.message : ''
            if (!/scan not found|job not found/i.test(message)) throw error
            for (const candidate of [runtime, defaultRuntime, ...runtimes.values()]) {
              if (candidate === runtime || typeof candidate[property] !== 'function') continue
              try {
                return await candidate[property](...args)
              } catch (candidateError) {
                const candidateMessage = candidateError instanceof Error ? candidateError.message : ''
                if (!/scan not found|job not found/i.test(candidateMessage)) throw candidateError
              }
            }
            throw error
          })
        }
      },
    })
  }

  async function initialize() {
    await registry.read()
    return registry.list()
  }

  return {
    config,
    registry,
    initialize,
    runtimeFor,
    prepare,
    preparePending,
    activeRuntime,
    proxyRuntime,
    run: (entry, operation) => contexts.run(entry, operation),
    runPending: (operation) => contexts.run(pendingContext, operation),
    context: contexts,
  }
}

export const bundleRegistryVersion = REGISTRY_VERSION
