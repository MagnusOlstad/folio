import type { Dispatch, RefObject, SetStateAction } from 'react'
import { apiForBundle } from '../../../lib/api.ts'
import {
  type TranscriptionDraftAdapter,
  type TranscriptionPhase,
  type TranscriptionSession,
} from '../model/types.ts'

export type SessionDraft = { draftId: string; bundleId: string | null }

/** Shared state of useTranscription that the draft-editing operations read and update. */
export type DraftWorkContext = {
  busyRef: RefObject<boolean>
  deletingRef: RefObject<string | null>
  activeBundle: RefObject<string | null>
  bundleGeneration: RefObject<number>
  sessionDrafts: RefObject<Map<string, SessionDraft>>
  draftsRef: RefObject<TranscriptionDraftAdapter>
  setError: (message: string) => void
  setMessage: (message: string) => void
  setPhase: (phase: TranscriptionPhase) => void
  setProgress: (progress: string) => void
  setActiveSession: Dispatch<SetStateAction<TranscriptionSession | null>>
  refresh: () => Promise<void>
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

/** The still-open draft this session produced, with its current text, or null once it was filed or closed. */
export function linkedDraft(ctx: DraftWorkContext, sessionId: string, bundle: string | null, prune = true) {
  let draft = ctx.sessionDrafts.current.get(sessionId)
  if (draft && (draft.bundleId !== bundle || !draft.draftId.startsWith('untitled:')
    || ctx.draftsRef.current.isDraftOpen?.(draft.draftId) === false)) {
    // Render-time callers must not prune: the adapter can lag a render behind a just-created draft.
    if (prune) ctx.sessionDrafts.current.delete(sessionId)
    draft = undefined
  }
  if (!draft) return null
  const content = ctx.draftsRef.current.getDraftContent(draft.draftId)
    ?? ctx.draftsRef.current.getDraftDocument(draft.draftId)?.content
  return content === undefined ? null : { draft, content }
}

/** Draft association indicator for the recording row; this is never used as speaker-name data. */
export function hasOpenLinkedDraft(ctx: DraftWorkContext, session: TranscriptionSession) {
  return linkedDraft(ctx, session.id, session.sourceBundleId ?? null, false) !== null
}

export async function regenerateSummary(ctx: DraftWorkContext, session: TranscriptionSession) {
  const { busyRef, deletingRef, activeBundle, bundleGeneration } = ctx
  if (busyRef.current || deletingRef.current === session.id) return
  const taskBundle = session.sourceBundleId ?? null
  if (activeBundle.current !== taskBundle) return
  const taskGeneration = bundleGeneration.current
  busyRef.current = true
  ctx.setError('')
  ctx.setActiveSession(session)
  ctx.setPhase('summarizing')
  ctx.setProgress('Summarizing the saved recording with the selected local text model…')
  try {
    await apiForBundle(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}/summarize`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    if (activeBundle.current !== taskBundle || bundleGeneration.current !== taskGeneration) return
    if (activeBundle.current === taskBundle && bundleGeneration.current === taskGeneration) ctx.setMessage('Summary saved to the recording.')
    await ctx.refresh()
    if (activeBundle.current === taskBundle && bundleGeneration.current === taskGeneration) {
      ctx.setPhase('idle')
      ctx.setProgress('')
    }
  } catch (summaryError) {
    if (activeBundle.current !== taskBundle || bundleGeneration.current !== taskGeneration) return
    const message = errorMessage(summaryError, 'Could not generate the local summary.')
    if (message.startsWith('Summary cancelled.')) {
      ctx.setError('')
      ctx.setMessage('Summary cancelled. The saved recording was kept.')
      ctx.setPhase('idle')
    } else {
      ctx.setError(message)
      ctx.setPhase('error')
    }
    ctx.setProgress('')
  } finally {
    busyRef.current = false
    if (activeBundle.current === taskBundle && bundleGeneration.current === taskGeneration) {
      ctx.setActiveSession((current) => current?.id === session.id ? null : current)
    }
  }
}
