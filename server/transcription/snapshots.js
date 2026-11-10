import fs from 'node:fs/promises'
import path from 'node:path'

function isWhisperConfig(config) {
  const vocabularySize = config?.n_vocab ?? config?.vocab_size
  return config && typeof config === 'object' && config.model_type === 'whisper'
    && Number.isInteger(vocabularySize) && vocabularySize >= 50_000
}

function isUsableConfig(model, config) {
  return model.purpose === 'diarization' ? Boolean(config) && typeof config === 'object' : isWhisperConfig(config)
}

async function completeSnapshot(directory, model) {
  try {
    const names = new Set(await fs.readdir(directory))
    if (model.requiredFiles.some((name) => !names.has(name))) return false
    const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'))
    if (!isUsableConfig(model, config)) return false
    for (const name of model.requiredFiles) {
      const file = await fs.stat(path.join(directory, name))
      if (!file.isFile() || file.size === 0) return false
    }
    return true
  } catch { return false }
}

export function repositoryRoot(cacheRoot, model) {
  return path.join(cacheRoot, `models--${model.repository.replaceAll('/', '--')}`)
}

export async function installedSnapshot(cacheRoot, model) {
  const directory = path.join(repositoryRoot(cacheRoot, model), 'snapshots', model.revision)
  if (!(await completeSnapshot(directory, model))) return null
  return directory
}

export async function folderBytes(directory) {
  let total = 0
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return total }
  await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) { total += await folderBytes(filename); return }
    try {
      const stats = await fs.stat(filename)
      if (stats.isFile()) total += stats.size
    } catch { /* incomplete file may disappear while checking */ }
  }))
  return total
}
