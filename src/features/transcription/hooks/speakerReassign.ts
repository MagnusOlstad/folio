import { apiForBundle } from '../../../lib/api.ts'
import { applyRetranscription } from '../model/retranscribe.ts'
import { parseSpeakerNames } from '../model/speakers.ts'
import type { TranscriptionResult, TranscriptionSession } from '../model/types.ts'
import { linkedDraft, type DraftWorkContext } from './draftWork.ts'

export type ReassignOutcome = { result: TranscriptionResult; draftUpdated: boolean }

/** Speaker names defined in the session's open draft, or null when no draft is open. Read-only: safe during render. */
export function linkedSpeakerNames(ctx: DraftWorkContext, session: TranscriptionSession) {
  const linked = linkedDraft(ctx, session.id, session.sourceBundleId ?? null, false)
  return linked ? parseSpeakerNames(linked.content) : null
}

/** POSTs a segment edit, then rewrites the Transcript section of the open linked draft (reconciling `## Speakers`). */
async function editSegments(ctx: DraftWorkContext, session: TranscriptionSession, action: string, body: object): Promise<ReassignOutcome> {
  const bundle = session.sourceBundleId ?? null
  const response = await apiForBundle<{ result: TranscriptionResult }>(bundle,
    `/api/transcriptions/${encodeURIComponent(session.id)}/segments/${action}`,
    { method: 'POST', body: JSON.stringify(body) })
  const existing = linkedDraft(ctx, session.id, bundle)
  if (!existing) return { result: response.result, draftUpdated: false }
  ctx.draftsRef.current.updateDraftContent(existing.draft.draftId, applyRetranscription(existing.content, response.result))
  return { result: response.result, draftUpdated: true }
}

/** Moves one segment to another speaker. Without an open draft only the stored result changes. */
export function reassignSegmentSpeaker(ctx: DraftWorkContext, session: TranscriptionSession, index: number, speaker: number) {
  return editSegments(ctx, session, 'speaker', { index, speaker })
}

/** Splits one segment at a character offset; the rest goes to `speaker` (the same speaker when null). */
export function splitTranscriptSegment(ctx: DraftWorkContext, session: TranscriptionSession, index: number, offset: number, speaker: number | null) {
  return editSegments(ctx, session, 'split', { index, offset, speaker })
}

/** Merges one segment into the previous one. */
export function mergeTranscriptSegment(ctx: DraftWorkContext, session: TranscriptionSession, index: number) {
  return editSegments(ctx, session, 'merge', { index })
}
