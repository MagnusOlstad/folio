import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const TRANSLATION_CACHE_VERSION = 1

// Content-addressed translation cache stored in <bundle>/.folio/translations.json.
// It is derived data and can be deleted at any time.
export function createTranslationCache(cachePath) {
  let entries = null
  let saveTail = Promise.resolve()
  let saveTimer = null
  let dirty = false

  async function load() {
    if (entries) return entries
    try {
      const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8'))
      const valid = parsed?.version === TRANSLATION_CACHE_VERSION && parsed.entries
        && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
      entries = valid ? parsed.entries : {}
    } catch {
      entries = {}
    }
    return entries
  }

  async function writeNow() {
    if (!dirty || !entries) return
    dirty = false
    const temporaryPath = `${cachePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await fs.writeFile(temporaryPath, `${JSON.stringify({ version: TRANSLATION_CACHE_VERSION, entries })}\n`)
      await fs.rename(temporaryPath, cachePath)
    } catch (error) {
      dirty = true
      await fs.rm(temporaryPath, { force: true }).catch(() => {})
      console.error(`Could not save the translation cache. ${error.message}`)
    }
  }

  function flush() {
    clearTimeout(saveTimer)
    saveTimer = null
    saveTail = saveTail.then(writeNow)
    return saveTail
  }

  function scheduleSave(delayMs = 1_000) {
    dirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => { void flush() }, delayMs)
    saveTimer.unref?.()
  }

  return {
    load,
    get: (hash) => entries?.[hash] || null,
    set(hash, entry) { entries[hash] = entry; scheduleSave() },
    delete(hash) { delete entries[hash]; scheduleSave() },
    keys: () => Object.keys(entries || {}),
    entries: () => entries || {},
    flush,
  }
}
