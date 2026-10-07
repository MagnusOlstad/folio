// Captures marketing screenshots of the FolioNotes desktop app (Electron) against
// a fictional demo bundle. Never touches ~/Documents/Folio or the real userData.
//
//   node scripts/site/seed-demo.mjs --app-root <app>       # fresh demo bundle (uses local model)
//   node scripts/site/enrich-demo.mjs --app-root <app>     # links + history revisions
//   node scripts/site/capture-screenshots.mjs --app-root <app> [--only hero,models] [--out dir]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launch, api, argValue, here, workDir } from './lib.mjs'

const out = path.resolve(argValue('--out', path.join(here, '..', '..', 'site', 'assets', 'screenshots')))
const only = argValue('--only', '')?.split(',').filter(Boolean)
fs.mkdirSync(out, { recursive: true })
const ids = JSON.parse(fs.readFileSync(path.join(workDir, 'ids.json'), 'utf8'))

const { app, page, base, docs } = await launch({ reset: true })
const results = []
await (async () => { await new Promise((r) => setTimeout(r, 2500)) })()
const sleep = (ms) => page.waitForTimeout(ms)
const sizes = {}
const setTheme_ = (id, scheme) => page.evaluate(([i, c]) => { document.documentElement.dataset.theme = i; document.documentElement.style.colorScheme = c }, [id, scheme])
// Saves the shot in the dark default theme, then again with a -light suffix (hero-dark -> hero-light).
async function shot(name, target = page, opts = {}) {
  const lightName = name === 'hero-dark.png' ? 'hero-light.png' : name.replace(/\.png$/, '-light.png')
  const take = async (n) => { const b = await target.screenshot({ path: path.join(out, n), animations: 'disabled', ...opts }); sizes[n] = `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` }
  await take(name)
  await setTheme_('light', 'light')
  await sleep(500)
  await take(lightName)
  await setTheme_('original', 'dark')
  await sleep(400)
}
async function around(locator, margin = 24) {
  const b = await locator.boundingBox()
  return { clip: { x: Math.max(0, b.x - margin), y: Math.max(0, b.y - margin), width: b.width + margin * 2, height: b.height + margin * 2 } }
}

async function settle() {
  await page.mouse.move(1000, 12)
  await sleep(400)
}
async function setSidebar(mode) {
  await page.locator('nav.sidebar-tabs button', { hasText: new RegExp(`^${mode}$`, 'i') }).first().click()
  await sleep(300)
}
async function openNote(title) {
  await setSidebar('explore')
  const f = page.locator('button.tree-file').filter({ hasText: title }).first()
  await f.scrollIntoViewIfNeeded()
  await f.click()
  await sleep(1200)
  await settle()
}
async function scrollNote(to) {
  await page.evaluate((t) => {
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      const cx = r.x + r.width / 2
      if (cx > 330 && cx < 1130 && r.height > 300 && el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = t === 'end' ? 99999 : t
    }
  }, to)
  await sleep(400)
}
async function openSettings(category) {
  await page.getByRole('button', { name: /^settings$/i }).click()
  await page.locator('.settings-dialog').waitFor()
  if (category) await page.locator(`[data-settings-category="${category}"]`).click()
  await sleep(600)
}
async function closeSettings() {
  await page.locator('.settings-close').click()
  await sleep(400)
}
async function prepare() {
  await page.waitForLoadState('domcontentloaded')
  await page.locator('button.tree-file').first().waitFor({ timeout: 30000 })
  const gs = page.locator('button.tree-directory').filter({ hasText: /getting-started/ })
  if (await gs.getAttribute('aria-expanded') === 'true') await gs.click()
  const rc = page.getByRole('button', { name: 'Collapse Recent concepts' })
  if (await rc.count()) await rc.click()
  await sleep(500)
}

const steps = {
  async filing() {
    await setSidebar('explore')
    await page.keyboard.press('Meta+t')
    const draft = page.getByRole('textbox', { name: 'Write a new note' })
    await draft.waitFor()
    await draft.fill(`Meeting notes: Lumen weekly design sync\n\n**Attendees:** Maya, Jonas, Priya\n\n## Discussion\n- Checklist component is ready for engineering handoff\n- Agreed to track activation per step, not just per session\n- Invite step moves above the fold in the next prototype\n\n## Action items\n- [ ] Maya: export final checklist specs\n- [ ] Priya: add step-level analytics events`)
    await sleep(500)
    await page.keyboard.press('Meta+Enter')
    await page.getByRole('dialog', { name: 'Filing confirmation' }).waitFor({ timeout: 120000 })
    await sleep(1500)
    await settle()
    await shot('capture-filing.png')
    await shot('filing-dialog.png', page, await around(page.getByRole('dialog', { name: 'Filing confirmation' })))
    await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: 'Filing confirmation' }).waitFor({ state: 'detached', timeout: 60000 })
    await sleep(2500)
  },
  async hero() {
    await openNote(/Lumen onboarding redesign/)
    await scrollNote(0)
    await shot('hero-dark.png')
  },
  async explorer() {
    await setSidebar('explore')
    await page.evaluate(() => document.querySelectorAll('.workbench-sidebar *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0 }))
    await sleep(400)
    const panel = page.locator('.sidebar-panel').first()
    const box = await panel.boundingBox()
    const last = await page.locator('button.tree-file').last().boundingBox()
    await shot('explorer.png', page, { clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, last.y + last.height + 14 - box.y) } })
  },
  async models() {
    await openSettings('models')
    await shot('models.png')
    await shot('settings-models.png', page.locator('.settings-dialog'))
    const box = await page.locator('#settings-panel-models .model-settings-group').first().boundingBox()
    await shot('models-card.png', page, { clip: { x: box.x - 8, y: box.y - 4, width: box.width + 16, height: box.height + 8 } })
    await closeSettings()
  },
  async search() {
    await setSidebar('search')
    await page.getByLabel('Search your notes').fill('how did usability testing go')
    await page.keyboard.press('Enter')
    await sleep(7000)
    await settle()
    await shot('search.png')
    await shot('search-pane.png', page.locator('aside.workbench-sidebar'))
  },
  async ask() {
    await setSidebar('ask')
    await page.getByLabel('Question for your notes').fill('What did we learn from the first Lumen usability test, and what are we changing?')
    await page.getByRole('button', { name: /ask notes/i }).click()
    await page.getByRole('button', { name: /thinking/i }).waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: /thinking/i }).waitFor({ state: 'detached', timeout: 480000 })
    await sleep(2500)
    await page.locator('.workbench-sidebar a', { hasText: /Lumen usability test/ }).first().click()
    await sleep(1800)
    await settle()
    await shot('ask.png')
    await page.evaluate(() => document.querySelectorAll('.workbench-sidebar *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0 }))
    await sleep(300)
    await shot('ask-pane.png', page.locator('aside.workbench-sidebar'))
  },
  async history() {
    await openNote(/Lumen usability test/)
    await page.getByRole('button', { name: /Older/ }).click()
    await sleep(1800)
    await page.getByRole('button', { name: /Older/ }).click()
    await sleep(1800)
    await settle()
    await shot('history.png')
    await shot('history-crop.png', page.locator('aside.workspace-right-pane [role=tabpanel]'))
    await page.getByRole('button', { name: /Newer/ }).click().catch(() => {})
    await page.getByRole('button', { name: /Newer/ }).click().catch(() => {})
    await sleep(600)
  },
  async links() {
    await openNote(/Lumen usability test/)
    await scrollNote('end')
    await settle()
    await shot('links.png')
    const rel = await page.getByText('Related', { exact: true }).first().boundingBox()
    const top = Math.max(60, rel.y - 380)
    await shot('links-crop.png', page, { clip: { x: 324, y: top, width: 796, height: Math.min(Math.round(rel.y + 220), 860) - top } })
  },
  async refile() {
    await openNote(/Weekend sourdough/)
    await page.getByRole('button', { name: 'Refile' }).click()
    await page.getByRole('dialog', { name: 'Refile note' }).waitFor()
    await page.waitForFunction(() => !/Choosing a path/.test(document.querySelector('[role=dialog][aria-label="Refile note"]')?.textContent || ''), null, { timeout: 180000 })
    await sleep(1200)
    await settle()
    await shot('refile.png')
    await shot('refile-dialog.png', page, await around(page.getByRole('dialog', { name: 'Refile note' })))
    await page.keyboard.press('Escape')
    await sleep(600)
  },
  async export() {
    await openNote(/Lumen usability test/)
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await sleep(500)
    await shot('export.png', page, { clip: { x: 300, y: 0, width: 830, height: 891 } })
    await page.keyboard.press('Escape')
  },
  async transcription() {
    const audio = path.join(workDir, 'lumen-design-sync.m4a')
    const aiff = path.join(workDir, 'lumen-design-sync-src.aiff')
    execFileSync('say', ['-v', 'Samantha', '-r', '165', '-o', aiff, "Okay, let's start the Lumen design sync. The usability test showed that four out of five people finished signup without help. The invite step is below the fold, so we will move it higher. We also agreed to call the new area team space. Tomas will update the prototype by Friday, and Priya will estimate the analytics changes."])
    execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, audio])
    await page.getByRole('tab', { name: /transcription/i }).click()
    await page.locator('input[aria-label="Choose local audio file"]').setInputFiles(audio)
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click()
    await page.getByRole('button', { name: 'Open draft' }).waitFor({ timeout: 300000 })
    await page.getByRole('button', { name: 'Summarize draft' }).click()
    await sleep(4000)
    for (let i = 0; i < 60; i++) {
      const st = await api(base, 'GET', '/api/mlx/status')
      if (!st.models.some((m) => m.busy || m.loading)) break
      await sleep(3000)
    }
    await sleep(2000)
    await sleep(1500)
    await settle()
    await shot('transcription.png')
    await shot('transcription-crop.png', page, { clip: { x: 316, y: 0, width: 1124, height: 891 } })
    await page.getByRole('tab', { name: /history/i }).click()
  },
  async okf() {
    const f = path.join(docs, 'Folio', 'bundle', ids.usability.slice(1))
    fs.copyFileSync(f, path.join(out, 'okf-note.md'))
  },
}
const order = ['hero', 'explorer', 'models', 'search', 'links', 'history', 'refile', 'export', 'filing', 'ask', 'transcription', 'okf']
export { steps }

await prepare()
for (const name of order) {
  const fn = steps[name]
  if (only?.length && !only.includes(name)) continue
  try { await fn(); results.push(`ok ${name}`) } catch (e) { results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: path.join(workDir, `fail-${name}.png`) }).catch(() => {}) }
}
console.log(results.join('\n'))
console.log(Object.entries(sizes).map(([k, v]) => `${k} ${v}`).join('\n'))
await app.close()
