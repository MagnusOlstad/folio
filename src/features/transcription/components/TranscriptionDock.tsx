import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DragEvent } from 'react'
import type { TranscriptionDockActions, TranscriptionDockModel } from '../hooks/useTranscription.ts'
import { playbackStore } from '../model/playback-store.ts'
import type { TranscriptionSession } from '../model/types.ts'
import { PlusIcon, RecordDotIcon } from './icons.tsx'
import { ModelNotices } from './ModelNotices.tsx'
import { RecorderPanel } from './RecorderPanel.tsx'
import { RecordingSourceSelect } from './RecordingSourceSelect.tsx'
import { RecordingRow, type RowConfirmation } from './RecordingRow.tsx'

export type TranscriptionDockProps = { model: TranscriptionDockModel; actions: TranscriptionDockActions }

export function TranscriptionDock({ model, actions }: TranscriptionDockProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const lastDeletingIdRef = useRef<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [confirming, setConfirming] = useState<{ id: string; kind: RowConfirmation } | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [learnedCounts, setLearnedCounts] = useState<Record<string, number>>({})
  const playback = useSyncExternalStore(playbackStore.subscribe, playbackStore.getSnapshot)
  const recorder = model.recording
  const recordingPhaseRef = useRef(recorder.phase)
  const stopRecordingRef = useRef(actions.stopRecording)
  const busy = model.phase === 'importing' || model.phase === 'downloading' || model.phase === 'transcribing' || model.phase === 'summarizing' || model.phase === 'cancelling-summary'
  const controlsBusy = busy || recorder.phase === 'requesting' || recorder.phase === 'recording' || recorder.phase === 'processing' || recorder.saving
  const status = model.status
  const selectedModelName = status?.modelName ?? (status?.modelId === 'whisperlarge' ? 'Whisper Large v3' : 'Whisper Large v3 Turbo')
  const canTranscribe = status?.canTranscribe === true
  const speakers = status?.diarization
  const speakersReady = speakers?.canDiarize === true
  const speakerOffer = Boolean(speakers) && !speakersReady

  useEffect(() => {
    recordingPhaseRef.current = recorder.phase
    stopRecordingRef.current = actions.stopRecording
  }, [actions.stopRecording, recorder.phase])

  useEffect(() => {
    if (model.deletingSessionId) {
      lastDeletingIdRef.current = model.deletingSessionId
      return
    }
    const deletedId = lastDeletingIdRef.current
    if (!deletedId) return
    lastDeletingIdRef.current = null
    if (!model.pending.some((session) => session.id === deletedId)) {
      setConfirming(null)
      headingRef.current?.focus()
    }
  }, [model.deletingSessionId, model.pending])

  useEffect(() => () => {
    if (recordingPhaseRef.current === 'recording' || recordingPhaseRef.current === 'requesting') stopRecordingRef.current()
  }, [])

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragging(false)
    if (controlsBusy) return
    const file = event.dataTransfer.files.item(0)
    if (file) actions.importFile(file)
  }

  function load(session: TranscriptionSession) {
    playbackStore.load(session.id, model.audioUrlFor(session), (session.durationMs ?? 0) / 1000)
  }

  function togglePlay(session: TranscriptionSession) {
    setExpandedId(session.id)
    load(session)
    playbackStore.toggle()
  }

  return (
    <section
      className={`transcription-dock${dragging ? ' is-dragging' : ''}`}
      aria-label="Local transcription"
      onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
      onDrop={onDrop}
    >
      <div className="transcription-header">
        <div ref={headingRef} className="transcription-title" tabIndex={-1}>
          <span className="transcription-audio-icon" aria-hidden="true">♫</span>
          <strong>Recordings</strong>
          <span className="transcription-count">{model.pending.length}</span>
        </div>
        {recorder.phase === 'idle' && (
          <button type="button" className="transcription-icon-button" aria-label="Start recording" title="Start recording" onClick={() => void actions.startRecording()} disabled={controlsBusy}>
            <RecordDotIcon />
          </button>
        )}
        <button type="button" className="transcription-icon-button" aria-label="Choose audio" title="Choose audio" onClick={() => inputRef.current?.click()} disabled={controlsBusy}>
          <PlusIcon />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".aac,.aiff,.flac,.m4a,.mp3,.wav,audio/*"
          aria-label="Choose local audio file"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.item(0)
            event.currentTarget.value = ''
            if (file && !controlsBusy) actions.importFile(file)
          }}
        />
      </div>

      {recorder.systemAudioSupported && recorder.phase === 'idle' && (
        <RecordingSourceSelect source={recorder.source} disabled={controlsBusy} onChange={actions.setRecordingSource} />
      )}
      <RecorderPanel recorder={recorder} actions={actions} busy={busy} />
      <ModelNotices
        status={status}
        selectedModelName={selectedModelName}
        speakerOffer={speakerOffer}
        controlsBusy={controlsBusy}
        onInstallModel={actions.installModel}
        onInstallSpeakerModel={actions.installSpeakerModel}
      />

      {model.progress && model.phase !== 'transcribing' && <p className="transcription-progress" role="status">{model.progress}</p>}
      {(model.phase === 'summarizing' || model.phase === 'cancelling-summary') && <p className="transcription-empty">Cancel waits for the current local model request; the saved recording stays unchanged.</p>}
      {model.error && <p className="transcription-error" role="alert">{model.error}</p>}

      {model.pending.length === 0 ? (
        <p className="transcription-empty">Record or add audio. Audio stays on this device.</p>
      ) : (
        <ul className="transcription-rows" aria-label="Recordings">
          {model.pending.map((session) => (
            <RecordingRow
              key={session.id}
              session={session}
              model={model}
              actions={actions}
              selectedModelName={selectedModelName}
              canTranscribe={canTranscribe}
              controlsBusy={controlsBusy}
              busy={busy}
              expanded={expandedId === session.id && session.state === 'ready'}
              playing={playback.sessionId === session.id && playback.playing}
              speakerCount={learnedCounts[session.id] ?? session.speakerCount ?? null}
              confirming={confirming?.id === session.id ? confirming.kind : null}
              onConfirm={(kind) => setConfirming(kind ? { id: session.id, kind } : null)}
              onToggleExpand={() => {
                if (expandedId !== session.id) load(session)
                setExpandedId(expandedId === session.id ? null : session.id)
              }}
              onSpeakerCount={(count) => setLearnedCounts((current) => current[session.id] === count ? current : { ...current, [session.id]: count })}
              onTogglePlay={() => togglePlay(session)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
