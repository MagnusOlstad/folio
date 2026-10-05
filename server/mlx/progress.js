import fs from 'node:fs/promises'
import path from 'node:path'
import { modelSnapshotRoot } from './snapshots.js'

export async function installationProgress({ cacheRoot, definition, installing, isInstalled, worker }) {
  if (!installing) return null
  let downloadedBytes = 0
  const countedFiles = new Set()
  async function countFile(entryPath) {
    try {
      const stat = await fs.stat(entryPath)
      if (!stat.isFile()) return
      const realPath = await fs.realpath(entryPath)
      if (countedFiles.has(realPath)) return
      countedFiles.add(realPath)
      downloadedBytes += stat.size
    } catch { /* an in-progress cache write may disappear between reads */ }
  }
  async function visitSnapshot(directory) {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return visitSnapshot(entryPath)
      if (entry.isFile() || entry.isSymbolicLink()) return countFile(entryPath)
    }))
  }
  await visitSnapshot(path.join(modelSnapshotRoot(cacheRoot, definition), definition.revision))
  const installed = await isInstalled(definition)
  const nativeProgress = worker?.downloadProgress
  if (nativeProgress) downloadedBytes = Math.max(downloadedBytes, nativeProgress.downloadedBytes)
  const totalBytes = definition.purpose === 'transcription'
    ? definition.downloadSizeBytes
    : nativeProgress?.totalBytes || definition.downloadSizeBytes
  const percent = installed ? 100 : Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100))
  return {
    downloadedBytes: Math.min(downloadedBytes, totalBytes),
    totalBytes,
    percent,
    phase: installed ? 'loading' : 'downloading',
  }
}
