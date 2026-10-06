// Seeds a fresh demo bundle by filing fictional notes through the real app API (local model).
import fs from 'node:fs'
import path from 'node:path'
import { prepareDemoDirs, launch, api, workDir } from './lib.mjs'
import { notes } from './demo/notes.mjs'

prepareDemoDirs({ fresh: true })
const { app, base } = await launch()
const ids = {}
try {
  for (const n of notes) {
    const content = n.content
    const t = Date.now()
    const res = await api(base, 'POST', '/api/notes', { content, timeZone: 'Europe/Oslo' })
    if (res.filing?.id && res.filing.mode !== 'append') {
      await api(base, 'POST', '/api/filing/confirm', { filingId: res.filing.id, action: 'accept' }).catch((e) => console.log('confirm', e.message))
    }
    ids[n.key] = res.note.id
    console.log(n.key, '->', res.note.id, `(${res.filing?.mode}, ${Date.now() - t}ms)`)
  }
  fs.writeFileSync(path.join(workDir, 'ids.json'), JSON.stringify(ids, null, 2))
} finally {
  await app.close()
}
