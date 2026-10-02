import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, apiForBundle } from '../../../lib/api.ts'
import { useAudioRecorder, type RecordingPhase } from './useAudioRecorder.ts'
import type { RecordingAssociation } from '../model/recording.ts'
import {
  mergeTranscriptionDraft,
  replaceMarkdownSection,
  type TranscriptionDraftAdapter,
  type TranscriptionPhase,
  type TranscriptionProcessResponse,
  type TranscriptionSession,
  type TranscriptionStatus,
} from '../model/types.ts'

export type TranscriptionDockModel = {
  phase: TranscriptionPhase
  activeSession: TranscriptionSession | null
  pending: TranscriptionSession[]
  status: TranscriptionStatus | null
  progress: string
  error: string
  deletingSessionId: string | null
  recording: { phase: RecordingPhase; duration: string; error: string; saving: boolean }
}

export type TranscriptionDockActions = {
  importFile: (file: File, association?: RecordingAssociation) => Promise<boolean>
  startRecording: () => Promise<void>
  stopRecording: () => void
  discardRecording: () => void
  retryRecording: () => Promise<void>
  installModel: () => void
  transcribe: (session: TranscriptionSession) => void
  cancel: (session: TranscriptionSession) => void
  openTranscript: (session: TranscriptionSession) => void
  regenerateSummary: (session: TranscriptionSession) => void
  deleteSession: (session: TranscriptionSession) => Promise<void>
}

type Options = {
  drafts: TranscriptionDraftAdapter
  setMessage: (message: string) => void
  sourceBundleId: string | null
}

type SessionResponse = { session: TranscriptionSession }
type SessionListResponse = TranscriptionSession[]
type SummaryResponse = { result: { summary: string; transcript: string } }
type SessionDraft = { draftId: string; bundleId: string | null }

const SUPPORTED_AUDIO = /\.(aac|aiff|flac|m4a|mp3|wav)$/i
const MAX_AUDIO_BYTES = 500 * 1024 * 1024

function isSession(value: unknown): value is TranscriptionSession {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string' && typeof candidate.state === 'string'
    && (candidate.draftId === null || typeof candidate.draftId === 'string')
}

function sessionList(value: unknown): TranscriptionSession[] {
  return Array.isArray(value) ? value.filter(isSession) : []
}

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

async function audioDuration(file: File): Promise<number | null> {
  if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve) => {
      const audio = new Audio()
      const cleanup = () => { audio.src = ''; URL.revokeObjectURL(url) }
      const timeout = window.setTimeout(() => { cleanup(); resolve(null) }, 2_500)
      audio.preload = 'metadata'
      audio.onloadedmetadata = () => {
        window.clearTimeout(timeout)
        const result = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null
        cleanup()
        resolve(result)
      }
      audio.onerror = () => { window.clearTimeout(timeout); cleanup(); resolve(null) }
      audio.src = url
    })
  } catch { URL.revokeObjectURL(url); return null }
}

export function useTranscription({ drafts, setMessage, sourceBundleId }: Options) {
  const [phase, setPhase] = useState<TranscriptionPhase>('idle')
  const [activeSession, setActiveSession] = useState<TranscriptionSession | null>(null)
  const [pending, setPending] = useState<TranscriptionSession[]>([])
  const [status, setStatus] = useState<TranscriptionStatus | null>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const activeBundle = useRef(sourceBundleId)
  const busyRef = useRef(false)
  const deletingRef = useRef<string | null>(null)
  const deletedSessionIds = useRef(new Set<string>())
  const sessionDrafts = useRef(new Map<string, SessionDraft>())
  const draftsRef = useRef(drafts)
  const recorder = useAudioRecorder({
    association: { sourceBundleId },
    onImport: importFile,
  })

  useLayoutEffect(() => { activeBundle.current = sourceBundleId }, [sourceBundleId])
  useLayoutEffect(() => { draftsRef.current = drafts }, [drafts])

  function draftFiled(oldId: string, _newId: string, bundleId: string) {
    for (const [sessionId, draft] of sessionDrafts.current) {
      if (draft.draftId === oldId && draft.bundleId === bundleId) sessionDrafts.current.delete(sessionId)
    }
  }

  async function refresh() {
    try {
      const [nextStatus, sessions] = await Promise.all([
        api<TranscriptionStatus>('/api/transcriptions/status'),
        api<SessionListResponse>('/api/transcriptions?pending=1'),
      ])
      setStatus(nextStatus)
      setPending(sessionList(sessions).filter((session) => !deletedSessionIds.current.has(session.id)
        && (!session.sourceBundleId || session.sourceBundleId === activeBundle.current)))
    } catch { /* the rest of the workspace remains usable if the local API is starting */ }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const interval = window.setInterval(() => void refresh(), phase === 'downloading' ? 1_000 : 5_000)
    return () => { window.clearTimeout(initial); window.clearInterval(interval) }
  }, [phase, sourceBundleId])

  useEffect(() => {
    if (activeSession?.sourceBundleId && activeSession.sourceBundleId !== sourceBundleId) {
      setActiveSession(null)
      setProgress('')
      setPhase('idle')
      setError('')
    }
  }, [sourceBundleId, activeSession?.sourceBundleId])

  async function importFile(file: File, association?: RecordingAssociation): Promise<boolean> {
    if (busyRef.current) return false
    busyRef.current = true
    setError('')
    const importBundle = association ? association.sourceBundleId : sourceBundleId
    if (!SUPPORTED_AUDIO.test(file.name)) {
      setError('Choose an AAC, AIFF, FLAC, M4A, MP3, or WAV audio file.')
      setPhase('error')
      busyRef.current = false
      return false
    }
    if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) {
      setError('Audio files must be greater than 0 bytes and 500 MB or smaller.')
      setPhase('error')
      busyRef.current = false
      return false
    }
    setPhase('importing')
    setProgress(`Saving ${file.name} on this device…`)
    try {
      const durationMs = await audioDuration(file)
      const created = await apiForBundle<SessionResponse>(importBundle, '/api/transcriptions', {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, durationMs, sourceBundleId: importBundle }),
      })
      await apiForBundle(importBundle, `/api/transcriptions/${encodeURIComponent(created.session.id)}/audio`, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (activeBundle.current !== importBundle) {
        setMessage(`Saved ${file.name}. Switch back to the source workspace to transcribe it.`)
      } else {
        setMessage(`Saved ${file.name} locally. Download Whisper if needed, then transcribe it.`)
      }
      await refresh()
      setPhase('idle')
      setProgress('')
      return true
    } catch (uploadError) {
      setError(errorMessage(uploadError, 'Could not save the audio file.'))
      setPhase('error')
      setProgress('')
      return false
    } finally { busyRef.current = false }
  }

  async function installModel() {
    if (busyRef.current) return
    busyRef.current = true
    setError('')
    setPhase('downloading')
    setProgress('Downloading Whisper weights and tokenizer files…')
    try {
      await api<TranscriptionStatus>('/api/transcriptions/model/install', { method: 'POST' })
      setMessage('Whisper is ready for local transcription.')
      await refresh()
      setPhase('idle')
      setProgress('')
    } catch (downloadError) {
      setError(errorMessage(downloadError, 'Could not download the Whisper model.'))
      setPhase('error')
      setProgress('')
    } finally { busyRef.current = false }
  }

  function openTranscriptDraft(session: TranscriptionSession, result: TranscriptionProcessResponse['result']) {
    const bundleId = session.sourceBundleId ?? null
    if (activeBundle.current !== bundleId) {
      setMessage('Transcription finished. Switch back to the source workspace to open its Markdown note.')
      return null
    }
    const draftId = draftsRef.current.createDraft(mergeTranscriptionDraft(session, result))
    sessionDrafts.current.set(session.id, { draftId, bundleId })
    setMessage('Transcript opened in a new editable draft.')
    return draftId
  }

  async function transcribe(session: TranscriptionSession) {
    if (busyRef.current || deletingRef.current === session.id) return
    const taskBundle = session.sourceBundleId ?? null
    busyRef.current = true
    setError('')
    setActiveSession(session)
    setPhase('transcribing')
    setProgress('Transcribing audio with local Whisper…')
    try {
      const response = await apiForBundle<TranscriptionProcessResponse>(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}/process`, { method: 'POST' })
      openTranscriptDraft({ ...response.session, sourceBundleId: taskBundle }, response.result)
      await refresh()
      setPhase('idle')
      setProgress('')
      setActiveSession(null)
    } catch (transcribeError) {
      setError(errorMessage(transcribeError, 'Could not transcribe the audio.'))
      setPhase('error')
      setProgress('')
      await refresh()
    } finally { busyRef.current = false }
  }

  async function cancel(session: TranscriptionSession) {
    if (phase === 'summarizing' && activeSession?.id === session.id) {
      setPhase('cancelling-summary')
      setProgress('Waiting for the current local model request to finish; its summary will be discarded…')
      try {
        const response = await apiForBundle<{ cancelled: boolean }>(session.sourceBundleId ?? null, `/api/transcriptions/${encodeURIComponent(session.id)}/summarize/cancel`, { method: 'POST' })
        setMessage(response.cancelled
          ? 'Summary cancelled. Your draft and original transcript were kept.'
          : 'Summary generation had already finished.')
      } catch (cancelError) {
        setError(errorMessage(cancelError, 'Could not cancel summary generation.'))
        setPhase('summarizing')
        setProgress('Summarizing the editable draft with the selected local text model…')
      }
      await refresh()
      return
    }
    try {
      await apiForBundle(session.sourceBundleId ?? null, `/api/transcriptions/${encodeURIComponent(session.id)}/cancel`, { method: 'POST' })
      setMessage('Transcription cancelled. The audio file is saved and can be retried.')
    } catch (cancelError) { setError(errorMessage(cancelError, 'Could not cancel transcription.')) }
    await refresh()
  }

  async function openTranscript(session: TranscriptionSession) {
    if (deletingRef.current === session.id) return
    setError('')
    try {
      const response = await apiForBundle<TranscriptionProcessResponse>(session.sourceBundleId ?? null, `/api/transcriptions/${encodeURIComponent(session.id)}`)
      if (!response.result) throw new Error('No transcript has been saved for this audio yet. Transcribe it first.')
      openTranscriptDraft(session, response.result)
    } catch (openError) { setError(errorMessage(openError, 'Could not open the transcript note.')); setPhase('error') }
  }

  async function deleteSession(session: TranscriptionSession) {
    if (deletingRef.current || (busyRef.current && activeSession?.id === session.id)
      || recorder.phase !== 'idle' || session.state === 'transcribing') return
    deletingRef.current = session.id
    setDeletingSessionId(session.id)
    setError('')
    try {
      await apiForBundle<{ deleted: boolean }>(session.sourceBundleId ?? null,
        `/api/transcriptions/${encodeURIComponent(session.id)}`, { method: 'DELETE' })
      sessionDrafts.current.delete(session.id)
      deletedSessionIds.current.add(session.id)
      setPending((sessions) => sessions.filter((item) => item.id !== session.id))
      if (activeSession?.id === session.id) {
        setActiveSession(null)
        setPhase('idle')
        setProgress('')
      }
      if (activeBundle.current === (session.sourceBundleId ?? null)) {
        setMessage('Deleted local audio, transcript, and summary. Any Markdown note you opened or saved was kept.')
      }
    } catch (deleteError) {
      if (activeBundle.current === (session.sourceBundleId ?? null)) setError(errorMessage(deleteError, 'Could not delete this transcription.'))
      await refresh()
    } finally {
      deletingRef.current = null
      setDeletingSessionId(null)
    }
  }

  async function regenerateSummary(session: TranscriptionSession) {
    if (busyRef.current || deletingRef.current === session.id) return
    const taskBundle = session.sourceBundleId ?? null
    if (activeBundle.current !== taskBundle) return
    busyRef.current = true
    setError('')
    setActiveSession(session)
    setPhase('summarizing')
    setProgress('Summarizing the editable draft with the selected local text model…')
    try {
      let draft = sessionDrafts.current.get(session.id)
      if (draft && (draft.bundleId !== taskBundle || !draft.draftId.startsWith('untitled:')
        || draftsRef.current.isDraftOpen?.(draft.draftId) === false)) {
        sessionDrafts.current.delete(session.id)
        draft = undefined
      }
      let current = draft ? (draftsRef.current.getDraftContent(draft.draftId)
        ?? draftsRef.current.getDraftDocument(draft.draftId)?.content) : undefined
      if (!draft || current === undefined) {
        const stored = await apiForBundle<TranscriptionProcessResponse>(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}`)
        if (activeBundle.current !== taskBundle) return
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
      const response = await apiForBundle<SummaryResponse>(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}/summarize`, {
        method: 'POST',
        body: JSON.stringify({ transcript }),
      })
      if (activeBundle.current !== taskBundle) return
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
      if (activeBundle.current === taskBundle) setMessage('Local summary added to an editable draft.')
      await refresh()
      setPhase('idle')
      setProgress('')
    } catch (summaryError) {
      const message = errorMessage(summaryError, 'Could not generate the local summary.')
      if (message.startsWith('Summary cancelled.')) {
        setError('')
        setMessage('Summary cancelled. Your draft and original transcript were kept.')
        setPhase('idle')
      } else {
        setError(message)
        setPhase('error')
      }
      setProgress('')
    } finally {
      busyRef.current = false
      setActiveSession((current) => current?.sourceBundleId === taskBundle ? null : current)
      if (activeBundle.current !== taskBundle) {
        setPhase((current) => current === 'summarizing' || current === 'cancelling-summary' ? 'idle' : current)
        setProgress('')
      }
    }
  }

  const model: TranscriptionDockModel = {
    phase,
    activeSession,
    pending: pending.filter((session) => !session.sourceBundleId || session.sourceBundleId === sourceBundleId),
    status,
    progress,
    error,
    deletingSessionId,
    recording: { phase: recorder.phase, duration: recorder.duration, error: recorder.error, saving: recorder.saving },
  }
  const actions: TranscriptionDockActions = {
    importFile: (file, association) => importFile(file, association),
    startRecording: recorder.start,
    stopRecording: recorder.stop,
    discardRecording: recorder.discard,
    retryRecording: recorder.retry,
    installModel: () => void installModel(),
    transcribe: (session) => void transcribe(session),
    cancel: (session) => void cancel(session),
    openTranscript: (session) => void openTranscript(session),
    regenerateSummary: (session) => void regenerateSummary(session),
    deleteSession,
  }
  return { model, actions, draftFiled }
}
