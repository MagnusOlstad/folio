import { apiForBundle } from '../../../lib/api.ts'
import type { TranscriptionResult, TranscriptionSession } from '../model/types.ts'

export type ReassignOutcome = { result: TranscriptionResult }

async function postResult(session: TranscriptionSession, path: string, body: object): Promise<ReassignOutcome> {
  const response = await apiForBundle<{ result: TranscriptionResult }>(session.sourceBundleId ?? null,
    `/api/transcriptions/${encodeURIComponent(session.id)}/${path}`,
    { method: 'POST', body: JSON.stringify(body) })
  return { result: response.result }
}

/** Segment corrections update only the saved recording result. */
export function reassignSegmentSpeaker(session: TranscriptionSession, index: number, speaker: number) {
  return postResult(session, 'segments/speaker', { index, speaker })
}

/** Splits a segment at a character offset; the rest goes to `speaker` (the same speaker when null). */
export function splitTranscriptSegment(session: TranscriptionSession, index: number, offset: number, speaker: number | null) {
  return postResult(session, 'segments/split', { index, offset, speaker })
}

/** Merges one segment into the previous one in the saved recording. */
export function mergeTranscriptSegment(session: TranscriptionSession, index: number) {
  return postResult(session, 'segments/merge', { index })
}

/** Merges all segments assigned to a speaker in the saved recording. */
export function mergeRecordingSpeakers(session: TranscriptionSession, source: number, target: number) {
  return postResult(session, 'speakers/merge', { source, target })
}

/** Renames a speaker in the saved recording result. */
export async function renameRecordingSpeaker(session: TranscriptionSession, speaker: number, name: string): Promise<TranscriptionResult> {
  const response = await postResult(session, 'speakers/name', { speaker, name })
  return response.result
}
