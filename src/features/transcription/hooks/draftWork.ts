import type { Dispatch, RefObject, SetStateAction } from 'react'
import { apiForBundle } from '../../../lib/api.ts'
import { applyRetranscription } from '../model/retranscribe.ts'
import { parseSpeakerNames, resolveSpeakerNames } from '../model/speakers.ts'
import {
  mergeTranscriptionDraft,
  replaceMarkdownSection,
  type TranscriptionDraftAdapter,
  type TranscriptionPhase,
  type TranscriptionProcessResponse,
  type TranscriptionResult,
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

type SummaryResponse = { result: { summary: string; transcript: string } }

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function transcriptSection(markdown: string) {
  const marker = /^## Transcript\s*\n/im
  const match = marker.exec(markdown)
  if (!match) return ''
  const start = match.index + match[0].length
  const rest = markdown.slice(start)
  const end = rest.search(/^##\s/m)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
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

/**
 * After a re-transcription: replaces the transcript (and reconciles speaker names) in the open linked
 * draft, or opens a fresh draft when there is none. Returns whether an existing draft was updated.
 */
export function applyRetranscribedResult(ctx: DraftWorkContext, session: TranscriptionSession, result: TranscriptionResult) {
  const bundle = session.sourceBundleId ?? null
  const existing = linkedDraft(ctx, session.id, bundle)
  if (!existing) return false
  ctx.draftsRef.current.updateDraftContent(existing.draft.draftId, applyRetranscription(existing.content, result))
  ctx.draftsRef.current.openDraft(existing.draft.draftId)
  return true
}

export async function regenerateSummary(ctx: DraftWorkContext, session: TranscriptionSession) {
  const { busyRef, deletingRef, activeBundle, bundleGeneration, sessionDrafts, draftsRef } = ctx
  if (busyRef.current || deletingRef.current === session.id) return
  const taskBundle = session.sourceBundleId ?? null
  if (activeBundle.current !== taskBundle) return
  const taskGeneration = bundleGeneration.current
  busyRef.current = true
  ctx.setError('')
  ctx.setActiveSession(session)
  ctx.setPhase('summarizing')
  ctx.setProgress('Summarizing the editable draft with the selected local text model…')
  try {
    const linked = linkedDraft(ctx, session.id, taskBundle)
    let draft = linked?.draft
    let current = linked?.content
    if (!draft || current === undefined) {
      const stored = await apiForBundle<TranscriptionProcessResponse>(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}`)
      if (activeBundle.current !== taskBundle || bundleGeneration.current !== taskGeneration) return
      if (!stored.result) throw new Error('No transcript has been saved for this audio yet. Transcribe it first.')
      current = mergeTranscriptionDraft(session, stored.result)
      const draftId = draftsRef.current.createDraft(current)
      draft = { draftId, bundleId: taskBundle }
      sessionDrafts.current.set(session.id, draft)
    } else {
      draftsRef.current.openDraft(draft.draftId)
    }
    const transcript = transcriptSection(current)
    if (!transcript) throw new Error('The transcript section is empty. Add transcript text to the draft before generating a summary.')
    // The summary reads real names: `{{speakerN}}` references resolve through the draft's Speakers section.
    const response = await apiForBundle<SummaryResponse>(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}/summarize`, {
      method: 'POST',
      body: JSON.stringify({ transcript: resolveSpeakerNames(transcript, parseSpeakerNames(current)) }),
    })
    if (activeBundle.current !== taskBundle || bundleGeneration.current !== taskGeneration) return
    const associated = sessionDrafts.current.get(session.id)
    const draftIsCurrent = associated?.draftId === draft.draftId && associated.bundleId === taskBundle
      && draft.draftId.startsWith('untitled:') && draftsRef.current.isDraftOpen?.(draft.draftId) !== false
    const latestContent = draftIsCurrent
      ? (draftsRef.current.getDraftContent(draft.draftId) ?? current)
      : current
    const finalContent = replaceMarkdownSection(latestContent, 'Summary', response.result.summary)
    if (draftIsCurrent) {
      draftsRef.current.updateDraftContent(draft.draftId, finalContent)
      draftsRef.current.openDraft(draft.draftId)
    } else {
      const newDraftId = draftsRef.current.createDraft(finalContent)
      sessionDrafts.current.set(session.id, { draftId: newDraftId, bundleId: taskBundle })
    }
    if (activeBundle.current === taskBundle && bundleGeneration.current === taskGeneration) ctx.setMessage('Local summary added to an editable draft.')
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
      ctx.setMessage('Summary cancelled. Your draft and original transcript were kept.')
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
