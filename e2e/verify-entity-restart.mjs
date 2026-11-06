import path from 'node:path'
import { createRuntime } from '../server/app.js'

const root = process.argv[2]
if (!root) throw new Error('Pass the entity E2E data root.')
const runtime = createRuntime({
  ...process.env,
  FOLIO_DATA_ROOT: root,
  FOLIO_BUNDLE_ROOT: path.join(root, 'bundle'),
  FOLIO_MODEL_ROOT: path.join(root, 'entity-models'),
  FOLIO_MLX_HELPER: path.resolve('test/fixtures/fake-mlx-helper.js'),
})
try {
  await runtime.entityService.restoreBundleSidecar()
  const [page, correction] = await Promise.all([
    runtime.entityService.listEntities({ activity: 'all', limit: 100 }),
    runtime.entityService.getLatestCorrectionUndoState(),
  ])
  process.stdout.write(JSON.stringify({ labels: page.items.map((entity) => entity.label), revision: correction.revision }))
} finally {
  await Promise.allSettled([runtime.mlxService.close(), runtime.transcriptionService.close()])
}
