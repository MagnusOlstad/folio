import { mergeRecordingSpeakers, mergeSegmentWithPrevious, reassignSegmentSpeaker, renameRecordingSpeaker, splitSegment } from './segments.js'

/** Serializes recording result edits and exposes the supported speaker/segment transformations. */
export function createRecordingEdits({ storage, active, locks, maxSpeakers }) {
  const queuedEdits = new Map()

  async function editSegments(id, transform) {
    const run = async () => {
      const session = await storage.readManifest(id)
      if (!session) throw Object.assign(new Error('Transcription session not found.'), { status: 404 })
      if (active.has(id) || locks.pendingTranscriptions.has(id) || session.state === 'transcribing') {
        throw Object.assign(new Error('Speakers cannot be changed while a transcription is running.'), { status: 409 })
      }
      const result = await storage.readResult(id)
      if (!result) throw Object.assign(new Error('Transcription result not found.'), { status: 404 })
      return storage.writeResult(id, transform(result))
    }
    const next = (queuedEdits.get(id) ?? Promise.resolve()).catch(() => undefined).then(run)
    queuedEdits.set(id, next)
    try { return await next } finally { if (queuedEdits.get(id) === next) queuedEdits.delete(id) }
  }

  return {
    editSegments,
    reassignSpeaker: (id, index, speaker) => editSegments(id, (result) => reassignSegmentSpeaker(result, index, speaker, { maxSpeakers: maxSpeakers() })),
    renameSpeaker: (id, speaker, name) => editSegments(id, (result) => renameRecordingSpeaker(result, speaker, name, { maxSpeakers: maxSpeakers() })),
    splitSegment: (id, index, offset, speaker) => editSegments(id, (result) => splitSegment(result, index, offset, speaker, { maxSpeakers: maxSpeakers() })),
    mergeSegment: (id, index) => editSegments(id, (result) => mergeSegmentWithPrevious(result, index)),
    mergeSpeakers: (id, source, target) => editSegments(id, (result) => mergeRecordingSpeakers(result, source, target, { maxSpeakers: maxSpeakers() })),
  }
}
