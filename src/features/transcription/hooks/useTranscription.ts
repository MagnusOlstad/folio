import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, apiForBundle } from '../../../lib/api.ts'
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
}

export type TranscriptionDockActions = {
  importFile: (file: File) => void
  installModel: () => void
  transcribe: (session: TranscriptionSession) => void
  cancel: (session: TranscriptionSession) => void
  openTranscript: (session: TranscriptionSession) => void
  regenerateSummary: (session: TranscriptionSession) => void
}

type Options = {
  drafts: TranscriptionDraftAdapter
  setMessage: (message: string) => void
  sourceNoteId: string | null
  sourceBundleId: string | null
}

type SessionResponse = { session: TranscriptionSession }
type SessionListResponse = TranscriptionSession[]
type SummaryResponse = { result: { summary: string; transcript: string } }

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

export function useTranscription({ drafts, setMessage, sourceNoteId, sourceBundleId }: Options) {
  const [phase, setPhase] = useState<TranscriptionPhase>('idle')
  const [activeSession, setActiveSession] = useState<TranscriptionSession | null>(null)
  const [pending, setPending] = useState<TranscriptionSession[]>([])
  const [status, setStatus] = useState<TranscriptionStatus | null>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const activeBundle = useRef(sourceBundleId)
  const busyRef = useRef(false)
  const draftsRef = useRef(drafts)

  useLayoutEffect(() => { activeBundle.current = sourceBundleId }, [sourceBundleId])
  useLayoutEffect(() => { draftsRef.current = drafts }, [drafts])

  function draftFiled(oldId: string, newId: string, bundleId: string) {
    if (activeBundle.current === bundleId) {
      setPending((sessions) => sessions.map((session) => session.draftId === oldId && session.sourceBundleId === bundleId
        ? { ...session, draftId: newId }
        : session))
      setActiveSession((session) => session?.draftId === oldId && session.sourceBundleId === bundleId
        ? { ...session, draftId: newId }
        : session)
    }
    void apiForBundle(bundleId, '/api/transcriptions/draft-remap', {
      method: 'POST',
      body: JSON.stringify({ oldId, newId, bundleId }),
    }).catch(() => undefined)
  }

  async function refresh() {
    try {
      const [nextStatus, sessions] = await Promise.all([
        api<TranscriptionStatus>('/api/transcriptions/status'),
        api<SessionListResponse>('/api/transcriptions?pending=1'),
      ])
      setStatus(nextStatus)
      setPending(sessionList(sessions).filter((session) => !session.sourceBundleId || session.sourceBundleId === activeBundle.current))
    } catch { /* the rest of the workspace remains usable if the local API is starting */ }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const interval = window.setInterval(() => void refresh(), phase === 'downloading' ? 1_000 : 5_000)
    return () => { window.clearTimeout(initial); window.clearInterval(interval) }
  }, [phase, sourceBundleId])

  useEffect(() => {
    setPending((sessions) => sessions.filter((session) => !session.sourceBundleId || session.sourceBundleId === sourceBundleId))
    if (activeSession?.sourceBundleId && activeSession.sourceBundleId !== sourceBundleId) {
      setActiveSession(null)
      setProgress('')
      setPhase('idle')
      setError('')
    }
  }, [sourceBundleId, activeSession?.sourceBundleId])

  async function importFile(file: File) {
    if (busyRef.current) return
    busyRef.current = true
    setError('')
    if (!SUPPORTED_AUDIO.test(file.name)) {
      setError('Choose an AAC, AIFF, FLAC, M4A, MP3, or WAV audio file.')
      setPhase('error')
      busyRef.current = false
      return
    }
    if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) {
      setError('Audio files must be greater than 0 bytes and 500 MB or smaller.')
      setPhase('error')
      busyRef.current = false
      return
    }
    const importBundle = sourceBundleId
    setPhase('importing')
    setProgress(`Saving ${file.name} on this device…`)
    try {
      const durationMs = await audioDuration(file)
      const created = await apiForBundle<SessionResponse>(importBundle, '/api/transcriptions', {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, durationMs, sourceNoteId, sourceBundleId: importBundle }),
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
    } catch (uploadError) {
      setError(errorMessage(uploadError, 'Could not save the audio file.'))
      setPhase('error')
      setProgress('')
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

  async function writeTranscriptNote(session: TranscriptionSession, result: TranscriptionProcessResponse['result']) {
    const bundleId = session.sourceBundleId ?? null
    if (activeBundle.current !== bundleId) {
      setMessage('Transcription finished. Switch back to the source workspace to open its Markdown note.')
      await refresh()
      return
    }
    const knownDraft = session.draftId
    const existing = knownDraft ? drafts.getDraftDocument(knownDraft) : undefined
    if (knownDraft && !existing && !knownDraft.startsWith('untitled:')) {
      try {
        await apiForBundle(bundleId, `/api/note?id=${encodeURIComponent(knownDraft)}`)
        if (activeBundle.current !== bundleId) {
          setMessage('Transcription finished. Switch back to the source workspace to open its Markdown note.')
          await refresh()
          return
        }
        drafts.openDraft(knownDraft)
        setMessage('The saved Markdown transcript note is open.')
        return
      } catch (error) {
        throw new Error(errorMessage(error, 'Could not open the saved transcript note.'))
      }
    }
    const draftId = existing ? knownDraft! : drafts.createDraft(mergeTranscriptionDraft(session, result))
    const content = existing ? (drafts.getDraftContent(draftId) ?? existing.content) : mergeTranscriptionDraft(session, result)
    if (existing) drafts.updateDraftContent(draftId, content)
    drafts.openDraft(draftId)
    try {
      await apiForBundle(bundleId, `/api/transcriptions/${encodeURIComponent(session.id)}/draft`, {
        method: 'POST',
        body: JSON.stringify({ draftId }),
      })
    } catch { /* the transcript remains safe in the workspace draft even if its session link cannot be stored */ }
    setMessage('Editable Markdown transcript opened in a new draft.')
  }

  async function transcribe(session: TranscriptionSession) {
    if (busyRef.current) return
    const taskBundle = session.sourceBundleId ?? null
    busyRef.current = true
    setError('')
    setActiveSession(session)
    setPhase('transcribing')
    setProgress('Transcribing audio with local Whisper…')
    try {
      const response = await apiForBundle<TranscriptionProcessResponse>(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}/process`, { method: 'POST' })
      await writeTranscriptNote({ ...response.session, sourceBundleId: taskBundle }, response.result)
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
          ? 'Summary cancelled. The edited transcript is saved and the previous summary was kept.'
          : 'Summary generation had already finished.')
      } catch (cancelError) {
        setError(errorMessage(cancelError, 'Could not cancel summary generation.'))
        setPhase('summarizing')
        setProgress('Generating a summary with the selected local text model…')
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
    setError('')
    try {
      const response = await apiForBundle<TranscriptionProcessResponse>(session.sourceBundleId ?? null, `/api/transcriptions/${encodeURIComponent(session.id)}`)
      if (!response.result) throw new Error('No transcript has been saved for this audio yet. Transcribe it first.')
      await writeTranscriptNote(session, response.result)
    } catch (openError) { setError(errorMessage(openError, 'Could not open the transcript note.')); setPhase('error') }
  }

  async function regenerateSummary(session: TranscriptionSession) {
    if (busyRef.current) return
    const draftId = session.draftId
    const taskBundle = session.sourceBundleId ?? null
    if (activeBundle.current !== taskBundle) return
    busyRef.current = true
    setError('')
    setActiveSession(session)
    setPhase('summarizing')
    setProgress('Generating a summary with the selected local text model…')
    try {
      let content = draftId ? draftsRef.current.getDraftContent(draftId) : undefined
      let baseContent = draftId ? draftsRef.current.getDraftDocument(draftId)?.content : undefined
      if (content === undefined && draftId && !draftId.startsWith('untitled:')) {
        const note = await apiForBundle<{ content?: string }>(taskBundle, `/api/note?id=${encodeURIComponent(draftId)}`)
        if (activeBundle.current !== taskBundle) return
        content = note.content
        baseContent = note.content
      }
      const stored = content === undefined
        ? await apiForBundle<TranscriptionProcessResponse>(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}`)
        : null
      const current = content ?? (stored?.result ? mergeTranscriptionDraft(session, stored.result) : '')
      const transcript = transcriptSection(current)
      if (!transcript) throw new Error('The transcript section is empty. Add transcript text to the Markdown note before generating a summary.')
      if (draftId && !draftId.startsWith('untitled:')) {
        await apiForBundle(taskBundle, `/api/note?id=${encodeURIComponent(draftId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: current, baseContent: baseContent ?? current, refreshEmbeddings: false }),
        })
      }
      const response = await apiForBundle<SummaryResponse>(taskBundle, `/api/transcriptions/${encodeURIComponent(session.id)}/summarize`, {
        method: 'POST',
        body: JSON.stringify({ transcript }),
      })
      if (activeBundle.current !== taskBundle) return
      const latestContent = draftId ? draftsRef.current.getDraftContent(draftId) : undefined
      const nextContent = replaceMarkdownSection(latestContent ?? current, 'Summary', response.result.summary)
      if (draftId && !draftId.startsWith('untitled:')) {
        await apiForBundle(taskBundle, `/api/note?id=${encodeURIComponent(draftId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: nextContent, baseContent: current, refreshEmbeddings: false }),
        })
        if (activeBundle.current !== taskBundle) return
      }
      const contentAfterSave = draftId ? draftsRef.current.getDraftContent(draftId) : undefined
      const finalContent = replaceMarkdownSection(contentAfterSave ?? nextContent, 'Summary', response.result.summary)
      if (draftId && contentAfterSave !== undefined && activeBundle.current === taskBundle) {
        draftsRef.current.updateDraftContent(draftId, finalContent)
        draftsRef.current.openDraft(draftId)
      }
      if (activeBundle.current === taskBundle) setMessage('Local summary regenerated from the edited transcript.')
      await refresh()
      setPhase('idle')
      setProgress('')
    } catch (summaryError) {
      const message = errorMessage(summaryError, 'Could not generate the local summary.')
      if (message.startsWith('Summary cancelled.')) {
        setError('')
        setMessage(message)
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

  const model: TranscriptionDockModel = { phase, activeSession, pending, status, progress, error }
  const actions: TranscriptionDockActions = {
    importFile: (file) => void importFile(file),
    installModel: () => void installModel(),
    transcribe: (session) => void transcribe(session),
    cancel: (session) => void cancel(session),
    openTranscript: (session) => void openTranscript(session),
    regenerateSummary: (session) => void regenerateSummary(session),
  }
  return { model, actions, draftFiled }
}
