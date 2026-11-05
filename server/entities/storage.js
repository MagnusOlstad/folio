import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createSerialQueue } from '../core/queue.js'
import { ENTITY_INDEX_VERSION, ENTITY_USER_STATE_VERSION, MAX_ENTITY_STATE_BYTES, validateIndex, validateUserState } from './model.js'

async function readJson(filePath, fallback) {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_ENTITY_STATE_BYTES) throw new Error('Entity state file exceeds the supported size limit.')
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeAtomic(filePath, value) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(encoded) > MAX_ENTITY_STATE_BYTES) throw new Error('Entity state file exceeds the supported size limit.')
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporaryPath, encoded, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

export function createEntityStorage(runtime) {
  const bundleId = runtime.entityBundleId || runtime.historyBundleId || 'legacy-bundle'
  const stateRoot = runtime.entityStateRoot || path.dirname(runtime.indexPath || path.join(runtime.dataRoot, 'state', 'bundles', bundleId, 'search-index.json'))
  const indexPath = path.join(stateRoot, 'entity-index.json')
  const userStatePath = path.join(stateRoot, 'entity-user-state.json')
  const queue = createSerialQueue()
  let correctionLedgerError = null

  async function readIndex() {
    try {
      const value = await readJson(indexPath, { version: ENTITY_INDEX_VERSION, bundleId, revision: 0, mentions: [], entities: [], coverage: {}, appliedCorrectionRevision: 0 })
      return validateIndex(value, bundleId)
    } catch {
      // The index is derived and may always be rebuilt from source and user state.
      return { version: ENTITY_INDEX_VERSION, bundleId, revision: 0, mentions: [], entities: [], coverage: {}, appliedCorrectionRevision: 0, stale: true }
    }
  }
  async function readUserState() {
    if (correctionLedgerError) throw Object.assign(new Error(`Entity correction ledger needs recovery: ${correctionLedgerError}`), { status: 503, code: 'ENTITY_LEDGER_DAMAGED' })
    try {
      const value = await readJson(userStatePath, { version: ENTITY_USER_STATE_VERSION, bundleId, revision: 0, entities: [], corrections: [], doNotMerge: [], noteLinks: [], mentionDecisions: [], relatedDismissals: [] })
      return validateUserState(value, bundleId)
    } catch (error) {
      if (error.code === 'ENOENT') throw error
      correctionLedgerError = error instanceof Error ? error.message : 'Invalid correction ledger.'
      throw Object.assign(new Error(`Entity correction ledger needs recovery: ${correctionLedgerError}`), { status: 503, code: 'ENTITY_LEDGER_DAMAGED' })
    }
  }
  async function initializeUserState() {
    try { return await readUserState() } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const empty = { version: ENTITY_USER_STATE_VERSION, bundleId, revision: 0, entities: [], corrections: [], doNotMerge: [], noteLinks: [], mentionDecisions: [], relatedDismissals: [] }
      await writeAtomic(userStatePath, empty)
      return empty
    }
  }
  return {
    bundleId, indexPath, userStatePath,
    readIndex,
    readUserState: initializeUserState,
    withLock: (operation) => queue(operation),
    writeIndex: (value) => writeAtomic(indexPath, validateIndex(value, bundleId)),
    writeUserState: async (value) => { validateUserState(value, bundleId); await writeAtomic(userStatePath, value); correctionLedgerError = null },
    getLedgerError: () => correctionLedgerError,
  }
}
