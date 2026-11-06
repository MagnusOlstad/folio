import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Per-note "auto translate" flags: <bundle>/.folio/translation-notes.json. Never stored in the note file.
export function createAutoTranslateStore(filePath) {
  let notes = null
  let loading = null
  let tail = Promise.resolve()

  function load() {
    loading ||= (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
        notes = parsed?.version === 1 && parsed.notes && typeof parsed.notes === 'object' && !Array.isArray(parsed.notes) ? parsed.notes : {}
      } catch { notes = {} }
    })()
    return loading
  }

  function save() {
    tail = tail.then(async () => {
      const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(temporaryPath, `${JSON.stringify({ version: 1, notes })}\n`)
        await fs.rename(temporaryPath, filePath)
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {})
        console.error(`Could not save the auto-translate settings. ${error.message}`)
      }
    })
    return tail
  }

  return {
    load,
    has: (id) => Boolean(notes?.[id]?.autoTranslate),
    ids: () => Object.keys(notes || {}).filter((id) => notes[id]?.autoTranslate),
    set(id, enabled) {
      if (enabled) notes[id] = { autoTranslate: true, since: new Date().toISOString() }
      else delete notes[id]
      return save()
    },
    move(oldId, newId) {
      if (!notes?.[oldId] || oldId === newId) return Promise.resolve()
      notes[newId] = notes[oldId]
      delete notes[oldId]
      return save()
    },
    // Removes one id, or every id below a folder when the argument ends with "/".
    remove(idOrFolder) {
      const ids = Object.keys(notes || {}).filter((id) => (idOrFolder.endsWith('/') ? id.startsWith(idOrFolder) : id === idOrFolder))
      if (!ids.length) return Promise.resolve()
      for (const id of ids) delete notes[id]
      return save()
    },
    flush: () => tail,
  }
}
