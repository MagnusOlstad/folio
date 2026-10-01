import { seedDataRoot } from './seed-data-root.mjs'

process.env.FOLIO_DATA_ROOT = await seedDataRoot()
process.env.PORT = process.env.FOLIO_E2E_PORT || '4174'
// This suite exercises real capture classification, embeddings, and answering
// through the bundled Swift MLX runtime and explicitly installed model files.

const { startServer } = await import('../server/index.js')
await startServer(Number(process.env.PORT))
