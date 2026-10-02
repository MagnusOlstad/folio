function conflict(message) { return Object.assign(new Error(message), { status: 409 }) }
function missing() { return Object.assign(new Error('Transcription session not found.'), { status: 404 }) }

export function createSessionLocks() {
  const activeUploads = new Set()
  const pendingTranscriptions = new Set()
  const pendingSummaries = new Set()
  const deleting = new Set()
  function begin(id, set, message) {
    if (deleting.has(id)) throw missing()
    if (set.has(id)) throw conflict(message)
    set.add(id)
  }
  return {
    deleting,
    activeUploads,
    pendingTranscriptions,
    pendingSummaries,
    beginUpload(id) {
      if (pendingTranscriptions.has(id) || pendingSummaries.has(id)) throw conflict('Wait for this transcription activity to finish before uploading audio.')
      begin(id, activeUploads, 'Audio is already uploading for this recording.')
    },
    beginTranscription(id) {
      if (activeUploads.has(id)) throw conflict('Wait for the audio upload to finish before transcribing it.')
      begin(id, pendingTranscriptions, 'This recording is already being transcribed.')
    },
    beginSummary(id) {
      if (activeUploads.has(id)) throw conflict('Wait for the audio upload to finish before generating a summary.')
      begin(id, pendingSummaries, 'A summary is already being generated for this audio.')
    },
    beginDelete(id, active, activeSummaries) {
      if (deleting.has(id)) throw conflict('This transcription is already being deleted.')
      if (activeUploads.has(id) || pendingTranscriptions.has(id) || pendingSummaries.has(id) || active.has(id) || activeSummaries.has(id)) {
        throw conflict('Wait for this transcription activity to finish before deleting it.')
      }
      deleting.add(id)
    },
  }
}
