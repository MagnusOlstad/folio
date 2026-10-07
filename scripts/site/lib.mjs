import { _electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = path.dirname(fileURLToPath(import.meta.url))
export function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : fallback
}
export const appRoot = path.resolve(argValue('--app-root', path.resolve(here, '..', '..')))
export const workDir = path.resolve(argValue('--work-dir', path.join(process.env.TMPDIR || '/tmp', 'folionotes-demo')))
export const realModels = path.join(process.env.HOME, 'Library', 'Application Support', 'Folio', 'models')

export function prepareDemoDirs({ fresh }) {
  if (fresh) fs.rmSync(workDir, { recursive: true, force: true })
  const docs = path.join(workDir, 'docs'), appdata = path.join(workDir, 'appdata')
  fs.mkdirSync(path.join(appdata, 'Folio'), { recursive: true })
  fs.mkdirSync(docs, { recursive: true })
  if (!fs.existsSync(path.join(docs, 'Folio'))) fs.cpSync(path.join(appRoot, 'seed-data'), path.join(docs, 'Folio'), { recursive: true })
  const link = path.join(appdata, 'Folio', 'models')
  // Read-only use of the already-downloaded model cache; never deleted or modified.
  if (!fs.existsSync(link)) fs.symlinkSync(realModels, link)
  return { docs, appdata }
}

export async function launch({ width = 1440, height = 900, reset = false } = {}) {
  const { docs, appdata } = prepareDemoDirs({ fresh: false })
  if (reset) {
    // Only ever touches the temp demo directories created by this tooling.
    for (const d of ['drafts', 'transcriptions']) fs.rmSync(path.join(docs, 'Folio', d), { recursive: true, force: true })
    fs.rmSync(path.join(appdata, 'Folio', 'renderer-storage.json'), { force: true })
  }
  const app = await _electron.launch({
    args: ['--lang=en-US', path.join(here, 'demo-main.mjs')],
    cwd: appRoot,
    env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', FOLIO_DEMO_DOCS: docs, FOLIO_DEMO_APPDATA: appdata, FOLIO_APP_ROOT: appRoot },
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win.isFullScreen()) win.setFullScreen(false)
    if (win.isMaximized()) win.unmaximize()
    win.setContentSize(w, h)
    win.center()
  }, [width, height])
  await page.waitForLoadState('domcontentloaded')
  return { app, page, base: new URL(page.url()).origin, docs, appdata }
}

export async function api(base, method, route, body) {
  const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  if (!r.ok) throw new Error(`${method} ${route} ${r.status}: ${text.slice(0, 300)}`)
  return json
}
