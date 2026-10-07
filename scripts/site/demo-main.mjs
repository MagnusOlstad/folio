// Wrapper entry for marketing captures: redirects Documents and appData to
// temp dirs, then loads the real electron/main.js unchanged.
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const { FOLIO_DEMO_DOCS, FOLIO_DEMO_APPDATA, FOLIO_APP_ROOT } = process.env
if (!FOLIO_DEMO_DOCS || !FOLIO_DEMO_APPDATA || !FOLIO_APP_ROOT) throw new Error('demo env missing')
app.setPath('documents', FOLIO_DEMO_DOCS)
app.setPath('appData', FOLIO_DEMO_APPDATA) // main.js derives userData from appData/Folio
app.setPath('downloads', path.join(FOLIO_DEMO_APPDATA, 'downloads'))
// Unpackaged, app.getVersion() reports Electron's version; report the app's own.
const { version } = JSON.parse(fs.readFileSync(path.join(FOLIO_APP_ROOT, 'package.json'), 'utf8'))
if (typeof app.setVersion === 'function') app.setVersion(version)
if (app.getVersion() !== version) app.getVersion = () => version
await import(pathToFileURL(path.join(FOLIO_APP_ROOT, 'electron', 'main.js')).href)
