// Adds cross-links and a few revisions of history to the seeded demo bundle.
import fs from 'node:fs'
import path from 'node:path'
import { launch, api, workDir } from './lib.mjs'

const ids = JSON.parse(fs.readFileSync(path.join(workDir, 'ids.json'), 'utf8'))
const { app, base } = await launch()
const get = (id) => api(base, 'GET', `/api/note?id=${encodeURIComponent(id)}`)
const patch = async (id, body) => {
  await api(base, 'PATCH', `/api/note?id=${encodeURIComponent(id)}`, body)
  await api(base, 'POST', `/api/note/history/checkpoint?id=${encodeURIComponent(id)}`)
}
const edit = async (id, fn) => { const n = await get(id); await patch(id, { content: fn(n.content) }) }
const link = (key, label) => `[${label}](${ids[key]})`
try {
  if (ids.review.startsWith('/design-review')) {
    const dest = '/project/lumen-onboarding'
    const r = await api(base, 'POST', '/api/file/move', { id: ids.review, directory: dest }).catch((e) => { console.log('move failed', e.message); return null })
    if (r) { ids.review = r.id || r.newId || `${dest}/${path.basename(ids.review)}`; console.log('moved ->', ids.review) }
  }
  // Drop the duplicated title line from the body (the title already shows in the header).
  for (const [key, id] of Object.entries(ids)) {
    if (['todo', 'daily'].includes(key)) continue
    await edit(id, (c) => { const lines = c.split('\n'); return /^#/.test(lines[0]) ? c : lines.slice(1).join('\n').replace(/^\n+/, '') })
  }
  const gap = () => new Promise((r) => setTimeout(r, 62_000))
  // Revisions for the usability note, a minute apart so history shows distinct moments.
  await edit(ids.usability, (c) => c.replace('Move the invite step higher, rename workspace to team space, rerun with three users.', 'Move the invite step higher, rename workspace to team space, rerun with three users.\n\n## Follow-up\n- [ ] Share the highlights reel with Jonas'))
  await gap()
  await edit(ids.usability, (c) => c.replace('Five moderated sessions', 'Five moderated 45-minute sessions'))
  await gap()
  await edit(ids.usability, (c) => c.replace('rerun with three users.', 'rerun with three users next Tuesday.') + `\n\n## Related\n- ${link('kickoff', 'Lumen onboarding redesign kickoff')}\n- ${link('review', 'Checklist component design review')}\n- ${link('norman', 'Notes on The Design of Everyday Things')}\n`)
  await gap()
  await edit(ids.usability, (c) => c.replace('- [ ] Share the highlights reel with Jonas', '- [x] Share the highlights reel with Jonas'))
  await edit(ids.kickoff, (c) => c + `\n## Related\n- ${link('usability', 'Usability test findings, round 1')}\n- ${link('review', 'Checklist component design review')}\n`)
  await edit(ids.review, (c) => c + `\n## Related\n- ${link('kickoff', 'Onboarding redesign kickoff')}\n- ${link('tokens', 'Design token naming convention')}\n- ${link('contrast', 'Accessibility contrast checklist')}\n`)
  await edit(ids.norman, (c) => c + `\n## Related\n- ${link('refui', 'Refactoring UI')}\n- ${link('inclusive', 'Inclusive Design Principles')}\n`)
  await edit(ids.tokens, (c) => c + `\n## Related\n- ${link('type', 'Type scale for product UI')}\n- ${link('contrast', 'Accessibility contrast checklist')}\n`)
  fs.writeFileSync(path.join(workDir, 'ids.json'), JSON.stringify(ids, null, 2))
  await api(base, 'POST', '/api/reindex')
  console.log('done')
} finally { await app.close() }
