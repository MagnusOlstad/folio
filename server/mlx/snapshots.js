import fs from 'node:fs/promises'
import path from 'node:path'

export function modelSnapshotRoot(cacheRoot, model) {
  return path.join(cacheRoot, `models--${model.repository.replaceAll('/', '--')}`, 'snapshots')
}

export async function findModelSnapshot(cacheRoot, model) {
  const root = modelSnapshotRoot(cacheRoot, model)
  try {
    const snapshot = path.join(root, model.revision)
    const files = new Set(await fs.readdir(snapshot))
    if (!files.has('config.json') || !files.has('tokenizer.json') || !files.has('tokenizer_config.json')) return null
    const config = JSON.parse(await fs.readFile(path.join(snapshot, 'config.json'), 'utf8'))
    if (!config || typeof config !== 'object' || !config.model_type) return null
    let shards = []
    if (files.has('model.safetensors.index.json')) {
      const index = JSON.parse(await fs.readFile(path.join(snapshot, 'model.safetensors.index.json'), 'utf8'))
      shards = [...new Set(Object.values(index.weight_map || {}))]
    } else if (files.has('model.safetensors')) {
      shards = ['model.safetensors']
    }
    if (!shards.length || !shards.every((name) => typeof name === 'string' && path.basename(name) === name && files.has(name))) return null
    for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', ...shards]) {
      const file = await fs.stat(path.join(snapshot, name))
      if (!file.isFile() || file.size === 0) return null
    }
    return snapshot
  } catch { /* cache has not been created */ }
  return null
}
