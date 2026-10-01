import { seedDataRoot } from './seed-data-root.mjs'
import path from 'node:path'

process.env.FOLIO_DATA_ROOT = await seedDataRoot()
process.env.FOLIO_MODEL_ROOT = path.join(process.env.FOLIO_DATA_ROOT, 'empty-mlx-models')
process.env.FOLIO_MLX_HELPER = path.join(process.env.FOLIO_DATA_ROOT, 'missing-mlx-helper')
process.env.PORT = process.env.FOLIO_E2E_PORT || '4173'
const { startServer } = await import('../server/index.js')
await startServer(Number(process.env.PORT))
