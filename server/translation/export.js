import { randomUUID } from 'node:crypto'

import { protectText, renderItems } from './blocks.js'
import {
  buildLanguageMessages, EXPORT_LANGUAGES, maxTokensFor, parseDirectTranslation, sanitizeModelText, TranslationOutputError,
} from './prompt.js'

export const MAIN_CACHE_TARGETS = ['en', 'no']

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

// On-demand translated export jobs. One job runs at a time; others wait FIFO.
export function createExportManager({ runtime, cache, readNote, installedModel, waitForTurn, translateBlock, closedFlag, retentionMs }) {
  const jobs = new Map()
  const waiting = []
  const timers = new Set()
  let running = null

  const cacheKey = (block, target) => (MAIN_CACHE_TARGETS.includes(target) ? block.hash : `${block.hash}:${target}`)
  const entryFor = (block, target) => cache.get(cacheKey(block, target))

  function lookupFor(target) {
    return (block) => {
      const entry = entryFor(block, target)
      if (!entry || entry.translation == null) return null
      return MAIN_CACHE_TARGETS.includes(target) && entry.source === target ? null : sanitizeModelText(entry.translation, block.text)
    }
  }

  // Translates via the English pivot when the main-cache entry allows it.
  async function translateToLanguage(block, target, modelId, mainEntry) {
    let text = block.text
    let pivot = null
    if (mainEntry && !mainEntry.failed && mainEntry.source === 'en') pivot = 'en'
    else if (mainEntry && !mainEntry.failed && mainEntry.source === 'no' && mainEntry.translation) { pivot = 'en'; text = mainEntry.translation }
    const protectedValue = pivot && text !== block.text ? protectText(text) : { text: block.protectedText, tokens: block.tokens }
    const messages = buildLanguageMessages(EXPORT_LANGUAGES[target], protectedValue.text, pivot ? 'English' : null)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await runtime.mlxService.generate(messages, { maxTokens: maxTokensFor(protectedValue.text), temperature: 0 })
      try {
        const translation = parseDirectTranslation(response?.text, protectedValue.tokens, text, protectedValue.text)
        return { translation, pivot, modelId: response?.modelId || modelId, translatedAt: new Date().toISOString() }
      } catch (error) {
        if (!(error instanceof TranslationOutputError)) throw error
      }
    }
    return { translation: null, failed: true, pivot, modelId, translatedAt: new Date().toISOString() }
  }

  function summary(job) {
    const base = { jobId: job.jobId, id: job.id, target: job.target, status: job.status, translatedBlocks: job.translatedBlocks, totalBlocks: job.totalBlocks, failedBlocks: job.failedBlocks || 0, phase: job.phase, lastTranslated: job.lastTranslated || null }
    if (job.status === 'done') return { ...base, title: job.title, description: job.description, content: job.content }
    if (job.status === 'failed') return { ...base, error: job.error }
    return base
  }

  function finish(job, status) {
    job.status = status
    job.phase = status
    const timer = setTimeout(() => { jobs.delete(job.jobId); timers.delete(timer) }, retentionMs)
    timer.unref?.()
    timers.add(timer)
  }

  async function runJob(job) {
    try {
      job.phase = 'waiting'
      const note = await readNote(job.id)
      await cache.load()
      const model = await installedModel({ fresh: true })
      if (!model) throw httpError(503, 'No generation model is installed.')
      const done = (block) => {
        const entry = entryFor(block, job.target)
        if (!entry || (entry.failed && entry.modelId !== model.id)) return false
        return MAIN_CACHE_TARGETS.includes(job.target) || Object.hasOwn(entry, 'pivot')
      }
      const count = () => {
        job.failedBlocks = note.blocks.filter((block) => entryFor(block, job.target)?.failed).length
        return note.blocks.filter(done).length
      }
      job.totalBlocks = note.blocks.length
      job.translatedBlocks = count()
      const seen = new Set()
      for (const block of note.blocks) {
        if (seen.has(block.hash)) continue
        seen.add(block.hash)
        if (done(block)) continue
        if (job.status !== 'running') return
        job.phase = 'waiting'
        if (!(await waitForTurn({ force: true }))) throw new Error('The translation model is not available.')
        if (job.status !== 'running') return
        job.phase = 'translating'
        let mainEntry = cache.get(block.hash)
        if (!mainEntry || (mainEntry.failed && mainEntry.modelId !== model.id)) {
          mainEntry = await translateBlock(block, model.id)
          cache.set(block.hash, mainEntry)
          if (job.status !== 'running') return
        }
        if (!MAIN_CACHE_TARGETS.includes(job.target)) {
          cache.set(cacheKey(block, job.target), await translateToLanguage(block, job.target, model.id, mainEntry))
        }
        const translated = entryFor(block, job.target)?.translation
        if (translated) job.lastTranslated = translated.replace(/\s+/g, ' ').trim().slice(0, 160)
        job.translatedBlocks = count()
      }
      if (job.status !== 'running') return
      job.phase = 'finishing'
      const lookup = lookupFor(job.target)
      job.title = (note.titleBlock && lookup(note.titleBlock)) || note.title
      job.description = (note.descriptionBlock && lookup(note.descriptionBlock)) || note.description
      job.content = renderItems(note.items, lookup)
      finish(job, 'done')
    } catch (error) {
      if (job.status !== 'running') return
      console.error(`Translated export of ${job.id} failed. ${error.message}`)
      job.error = 'The note could not be translated. Check that the generation model is installed and try again.'
      finish(job, 'failed')
    } finally {
      await cache.flush()
    }
  }

  function kick() {
    if (running || closedFlag()) return
    running = (async () => {
      while (waiting.length && !closedFlag()) {
        const job = waiting.shift()
        if (job.status === 'running') await runJob(job)
      }
    })().finally(() => { running = null })
  }

  async function start(id, target) {
    if (!Object.hasOwn(EXPORT_LANGUAGES, target)) throw httpError(400, 'Choose a supported target language.')
    if (!runtime.resolveBundleMarkdownPath(id)) throw httpError(400, 'Only bundle notes can be translated.')
    const note = await readNote(id)
    if (!(await installedModel({ fresh: true }))) throw httpError(503, 'Install a generation model to translate notes.')
    await cache.load()
    const existing = [...jobs.values()].find((job) => job.id === id && job.target === target && job.status === 'running')
    if (existing) return summary(existing)
    const job = { jobId: randomUUID(), id, target, status: 'running', phase: 'queued', lastTranslated: null, translatedBlocks: 0, totalBlocks: note.blocks.length }
    jobs.set(job.jobId, job)
    waiting.push(job)
    kick()
    return summary(job)
  }

  function get(jobId) {
    const job = jobs.get(jobId)
    return job ? summary(job) : null
  }

  function cancel(jobId) {
    const job = jobs.get(jobId)
    if (!job) return null
    if (job.status === 'running') {
      finish(job, 'cancelled')
      const index = waiting.indexOf(job)
      if (index >= 0) waiting.splice(index, 1)
    }
    return { jobId, status: job.status }
  }

  function close() {
    for (const job of jobs.values()) if (job.status === 'running') job.status = 'cancelled'
    waiting.length = 0
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    jobs.clear()
  }

  return {
    start, get, cancel, close,
    pending: () => waiting.length > 0 || Boolean(running),
    idle: async () => { while (running) await running },
  }
}
