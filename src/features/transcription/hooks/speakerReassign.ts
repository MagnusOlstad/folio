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

/**
 * Moves one segment to another speaker on the server, then rewrites the Transcript section of the open
 * linked draft (reconciling `## Speakers`). Without an open draft only the stored result changes.
 */
export async function reassignSegmentSpeaker(
  ctx: DraftWorkContext,
  session: TranscriptionSession,
  index: number,
  speaker: number,
): Promise<ReassignOutcome> {
  const bundle = session.sourceBundleId ?? null
  const response = await apiForBundle<{ result: TranscriptionResult }>(bundle,
    `/api/transcriptions/${encodeURIComponent(session.id)}/segments/speaker`,
    { method: 'POST', body: JSON.stringify({ index, speaker }) })
  const existing = linkedDraft(ctx, session.id, bundle)
  if (!existing) return { result: response.result, draftUpdated: false }
  ctx.draftsRef.current.updateDraftContent(existing.draft.draftId, applyRetranscription(existing.content, response.result))
  return { result: response.result, draftUpdated: true }
}
