import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function seedDataRoot() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-e2e-'))
  await fs.cp(path.resolve('seed-data'), dataRoot, { recursive: true })
  return dataRoot
}
