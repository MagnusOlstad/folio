import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { createTranslationCache } from './cache.js'
import { createExportManager } from './export.js'
import { createTextBlock, renderItems, splitBody, translatableBlocks } from './blocks.js'
import {
  buildDirectTranslationMessages, buildTranslationMessages, maxTokensFor, parseDirectTranslation, parseTranslationOutput,
  sameTranslationText, TranslationOutputError,
} from './prompt.js'

const TARGETS = ['en', 'no']
const MAX_CONSECUTIVE_ERRORS = 3

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

export function createTranslationService(runtime, options = {}) {
  const settings = { debounceMs: 2_000, backfillDelayMs: 5_000, busyPollMs: 500, statusTtlMs: 5_000, exportRetentionMs: 10 * 60_000, ...runtime.translationOptions, ...options }
  const settingsPath = path.join(runtime.modelRoot, 'translation-settings.json')
  const cache = createTranslationCache(path.join(runtime.bundleRoot, '.folio', 'translations.json'))
  const queue = []
  const priority = new Set()
  const debounceTimers = new Map()
  const versions = new Map()
  const sleepers = new Set()
  let running = null
  let backfill = null
  let backfillTimer = null
  let closed = false
  let modelCache = { at: 0, value: null }

  function sleep(ms) {
    return new Promise((resolve) => {
      // Ref'd on purpose: callers await this (idle(), busy polling), so it must keep the event loop alive.
      const timer = setTimeout(() => { sleepers.delete(done); resolve() }, ms)
      const done = () => { clearTimeout(timer); sleepers.delete(done); resolve() }
      sleepers.add(done)
    })
  }

  async function isEnabled() {
    try {
      const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
      return saved.enabled !== false
    } catch { return true }
  }

  async function setEnabled(enabled) {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`
    await fs.writeFile(temporaryPath, JSON.stringify({ enabled }), 'utf8')
    await fs.rename(temporaryPath, settingsPath)
    if (!enabled) { queue.length = 0; priority.clear() }
    return getSettings()
  }

  // The selected generation model when it is installed, otherwise null. Never downloads.
  async function installedModel({ fresh = false } = {}) {
    if (!fresh && Date.now() - modelCache.at < settings.statusTtlMs) return modelCache.value
    let value = null
    try {
      const status = await runtime.mlxService.status()
      if (status.available !== false) {
        const model = (status.models || []).find((item) => item.purpose === 'generation' && item.selected && item.installed)
        value = model ? { id: model.id } : null
      }
    } catch { value = null }
    modelCache = { at: Date.now(), value }
    return value
  }

  async function getSettings() {
    return { enabled: await isEnabled(), available: Boolean(await installedModel({ fresh: true })) }
  }

  async function readNote(id) {
    const filePath = runtime.resolveBundleMarkdownPath(id)
    if (!filePath) throw httpError(400, 'Only bundle notes can be translated.')
    let markdown
    try {
      await runtime.assertNoBundleSymlinks(filePath)
      markdown = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError(404, 'Note not found.')
      throw error
    }
    const parsed = runtime.parseMarkdownFile(markdown, filePath)
    const items = splitBody(parsed.content)
    return {
      title: parsed.title,
      description: parsed.description,
      titleBlock: createTextBlock(parsed.title),
      descriptionBlock: createTextBlock(parsed.description),
      items,
      blocks: [createTextBlock(parsed.title), createTextBlock(parsed.description), ...translatableBlocks(items)].filter(Boolean),
    }
  }

  const exports = createExportManager({
    runtime, cache, readNote, installedModel, translateBlock: (block, modelId) => translateBlock(block, modelId),
    waitForTurn: (options) => waitForTurn(options), closedFlag: () => closed, retentionMs: settings.exportRetentionMs,
  })

  function needsWork(block, modelId) {
    const entry = cache.get(block.hash)
    if (!entry) return true
    if (entry.failed && entry.modelId !== modelId) { cache.delete(block.hash); return true }
    return false
  }

  async function translateBlock(block, modelId) {
    const messages = buildTranslationMessages(block.protectedText)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await runtime.mlxService.generate(messages, { maxTokens: maxTokensFor(block.protectedText), temperature: 0 })
      try {
        const parsed = parseTranslationOutput(response?.text, block.tokens, block.text, block.protectedText)
        let { translation } = parsed
        if (parsed.source !== 'other' && sameTranslationText(translation, block.text)) {
          try {
            const direct = await runtime.mlxService.generate(buildDirectTranslationMessages(parsed.source, block.protectedText),
              { maxTokens: maxTokensFor(block.protectedText), temperature: 0 })
            translation = parseDirectTranslation(direct?.text, block.tokens, block.text, block.protectedText)
          } catch (error) {
            if (!(error instanceof TranslationOutputError)) throw error
          }
        }
        return { source: parsed.source, translation, modelId: response?.modelId || modelId, translatedAt: new Date().toISOString() }
      } catch (error) {
        if (!(error instanceof TranslationOutputError)) throw error
      }
    }
    return { source: 'other', translation: null, failed: true, modelId, translatedAt: new Date().toISOString() }
  }

  // Waits until user-facing model work has finished. Returns false when work should stop.
  async function waitForTurn({ force = false } = {}) {
    while (!closed) {
      if ((!force && !(await isEnabled())) || !(await installedModel())) return false
      if (!force && exports.pending()) { await sleep(settings.busyPollMs); continue }
      if (!runtime.mlxService.isBusy?.()) return true
      await sleep(settings.busyPollMs)
    }
    return false
  }

  async function processNote(id) {
    const version = versions.get(id) || 0
    let note
    try { note = await readNote(id) } catch { return 'done' }
    const seen = new Set()
    let errors = 0
    for (const block of note.blocks) {
      if (seen.has(block.hash)) continue
      seen.add(block.hash)
      if (!cache.get(block.hash) || cache.get(block.hash).failed) {
        if (!(await waitForTurn())) return 'stop'
        if ((versions.get(id) || 0) !== version) return 'done'
        if (priority.size && !priority.has(id)) return 'yield'
        const model = await installedModel()
        if (!model) return 'stop'
        if (!needsWork(block, model.id)) continue
        try {
          cache.set(block.hash, await translateBlock(block, model.id))
        } catch (error) {
          console.error(`Could not translate a block of ${id}. ${error.message}`)
          errors += 1
          if (errors >= MAX_CONSECUTIVE_ERRORS) return 'stop'
        }
      }
    }
    return 'done'
  }

  async function runQueue() {
    await cache.load()
    while (queue.length && !closed) {
      if (!(await isEnabled()) || !(await installedModel())) { queue.length = 0; priority.clear(); break }
      const id = queue.shift()
      let outcome = 'done'
      try { outcome = await processNote(id) } catch (error) { console.error(`Translation of ${id} failed. ${error.message}`) }
      priority.delete(id)
      if (outcome === 'yield') queue.push(id)
      if (outcome === 'stop') queue.length = 0
    }
    await cache.flush()
  }

  function kick() {
    if (running || closed) return
    running = runQueue().catch((error) => console.error(`Translation queue failed. ${error.message}`)).finally(() => { running = null })
  }

  function addToQueue(id, { front = false } = {}) {
    const index = queue.indexOf(id)
    if (index >= 0) queue.splice(index, 1)
    if (front) queue.unshift(id)
    else queue.push(id)
    kick()
  }

  function validId(id) {
    return Boolean(runtime.resolveBundleMarkdownPath(id))
  }

  function enqueue(id) {
    if (closed || !validId(id)) return false
    versions.set(id, (versions.get(id) || 0) + 1)
    clearTimeout(debounceTimers.get(id))
    if (!settings.debounceMs) { addToQueue(id); return true }
    const timer = setTimeout(() => { debounceTimers.delete(id); addToQueue(id) }, settings.debounceMs)
    timer.unref?.()
    debounceTimers.set(id, timer)
    return true
  }

  function prioritize(id) {
    if (closed || !validId(id)) return false
    clearTimeout(debounceTimers.get(id))
    debounceTimers.delete(id)
    priority.add(id)
    addToQueue(id, { front: true })
    return true
  }

  async function runBackfill() {
    if (closed || !(await isEnabled())) return
    const model = await installedModel()
    if (!model) return
    await cache.load()
    const startedAt = new Date().toISOString()
    const referenced = new Set()
    const stale = []
    let complete = true
    for (const filePath of await runtime.listBundleMarkdownFiles()) {
      if (closed) return
      const id = runtime.bundleFileId(filePath)
      try {
        const note = await readNote(id)
        for (const block of note.blocks) referenced.add(block.hash)
        if (!id.startsWith('/references/inbox/') && note.blocks.some((block) => needsWork(block, model.id))) stale.push(id)
      } catch { complete = false }
      await new Promise((resolve) => setImmediate(resolve))
    }
    for (const id of stale) if (!queue.includes(id)) queue.push(id)
    kick()
    if (!complete) return
    for (const [hash, entry] of Object.entries(cache.entries())) {
      if (!referenced.has(hash.split(':')[0]) && String(entry.translatedAt) < startedAt) cache.delete(hash)
    }
  }

  function startBackfill() {
    if (closed) return
    clearTimeout(backfillTimer)
    backfillTimer = setTimeout(() => {
      backfill = runBackfill().catch((error) => console.error(`Translation backfill failed. ${error.message}`)).finally(() => { backfill = null })
    }, settings.backfillDelayMs)
    backfillTimer.unref?.()
  }

  async function view(id, target) {
    if (!TARGETS.includes(target)) throw httpError(400, 'Target must be en or no.')
    const note = await readNote(id)
    await cache.load()
    const lookup = (block) => {
      const entry = cache.get(block.hash)
      return !entry || entry.translation == null || entry.source === target ? null : entry.translation
    }
    const translatedBlocks = note.blocks.filter((block) => cache.get(block.hash)).length
    const totalBlocks = note.blocks.length
    const enabled = await isEnabled()
    const available = enabled ? Boolean(await installedModel()) : false
    const ready = translatedBlocks === totalBlocks
    if (enabled && available && !ready) prioritize(id)
    return {
      id,
      target,
      status: !enabled ? 'disabled' : ready ? 'ready' : available ? 'pending' : 'unavailable',
      translatedBlocks,
      totalBlocks,
      title: (note.titleBlock && lookup(note.titleBlock)) || note.title,
      description: (note.descriptionBlock && lookup(note.descriptionBlock)) || note.description,
      content: renderItems(note.items, lookup),
    }
  }

  async function idle() {
    while (running || backfill || queue.length || debounceTimers.size || exports.pending()) await (running || backfill || sleep(10))
  }

  async function close() {
    closed = true
    exports.close()
    queue.length = 0
    priority.clear()
    clearTimeout(backfillTimer)
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    for (const wake of [...sleepers]) wake()
    await Promise.race([Promise.allSettled([running, backfill].filter(Boolean)), new Promise((resolve) => setTimeout(resolve, 3_000).unref?.())])
    await cache.flush()
  }

  return { enqueue, prioritize, startBackfill, view, getSettings, setEnabled, idle, close, validId,
    startExport: exports.start, getExport: exports.get, cancelExport: exports.cancel }
}
