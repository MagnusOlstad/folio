import { apiForBundle } from '../../../lib/api.ts'
import { setSpeakerName } from '../model/speakers.ts'
import type { TranscriptionProcessResponse, TranscriptionSession } from '../model/types.ts'
import { linkedDraft, type DraftWorkContext } from './draftWork.ts'

/** Opens a fresh draft from the stored result (transforming its text first); returns its id, or null when it cannot be opened here. */
export type OpenTranscriptDraft = (
  session: TranscriptionSession,
  result: TranscriptionProcessResponse['result'],
  transform?: (content: string) => string,
) => string | null

/**
 * Writes `speakerN:: name` into the session's linked draft. Without an open draft one is created from
 * the stored result with the name already applied, so the user performs a single action.
 */
export async function renameSpeakerInDraft(
  ctx: DraftWorkContext,
  session: TranscriptionSession,
  number: number,
  name: string,
  openDraft: OpenTranscriptDraft,
): Promise<void> {
  const bundle = session.sourceBundleId ?? null
  const existing = linkedDraft(ctx, session.id, bundle)
  if (existing) {
    ctx.draftsRef.current.updateDraftContent(existing.draft.draftId, setSpeakerName(existing.content, number, name))
    return
  }
  const response = await apiForBundle<TranscriptionProcessResponse>(bundle, `/api/transcriptions/${encodeURIComponent(session.id)}`)
  if (!response.result) throw new Error('No transcript has been saved for this audio yet. Transcribe it first.')
  const draftId = openDraft({ ...session, sourceBundleId: bundle }, response.result, (content) => setSpeakerName(content, number, name))
  if (!draftId) throw new Error('Switch back to the source workspace to rename speakers.')
}
