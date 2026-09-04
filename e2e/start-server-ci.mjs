import { seedDataRoot } from './seed-data-root.mjs'

process.env.FOLIO_DATA_ROOT = await seedDataRoot()
process.env.PORT = process.env.FOLIO_E2E_PORT || '4173'
// Point at a loopback port nothing listens on so the suite exercises the app's
// offline UI deterministically, regardless of whether the host machine happens
// to have a real Ollama running.
process.env.OLLAMA_URL = 'http://127.0.0.1:1'

const { startServer } = await import('../server/index.js')
await startServer(Number(process.env.PORT))
