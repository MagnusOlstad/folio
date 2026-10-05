export function recordDownloadProgress(stages, event) {
  if (!Number.isFinite(event.downloadedBytes) || !Number.isFinite(event.totalBytes)
    || event.downloadedBytes < 0 || event.totalBytes <= 0) return

  const scope = typeof event.scope === 'string' && event.scope ? event.scope : 'model'
  const previous = stages.get(scope)
  if (event.complete === true) {
    const bytes = Math.max(0, event.downloadedBytes)
    stages.set(scope, { downloadedBytes: bytes, totalBytes: Math.max(bytes, event.totalBytes) })
    return
  }

  // HubClient reports a synthetic 1/1 progress object for an already-cached snapshot.
  if (event.totalBytes <= 1) return
  const totalBytes = event.totalBytes
  const downloadedBytes = Math.min(totalBytes, Math.max(0, event.downloadedBytes))
  stages.set(scope, {
    downloadedBytes: Math.max(previous?.downloadedBytes || 0, downloadedBytes),
    totalBytes,
  })
}

export function summarizeDownloadProgress(stages) {
  let downloadedBytes = 0
  let totalBytes = 0
  for (const progress of stages.values()) {
    downloadedBytes += progress.downloadedBytes
    totalBytes += progress.totalBytes
  }
  return totalBytes > 0 ? { downloadedBytes, totalBytes } : null
}
