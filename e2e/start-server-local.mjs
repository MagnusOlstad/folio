import { seedDataRoot } from './seed-data-root.mjs'

process.env.FOLIO_DATA_ROOT = await seedDataRoot()
process.env.PORT = process.env.FOLIO_E2E_PORT || '4174'
// Deliberately leave OLLAMA_URL at its default (or whatever the environment
// sets) so this suite exercises real capture classification, embeddings, and
// answering against a real local Ollama.

const { startServer } = await import('../server/index.js')
await startServer(Number(process.env.PORT))
