import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { TranscriptionDockActions, TranscriptionDockModel } from '../hooks/useTranscription.ts'
import type { TranscriptionSession } from '../model/types.ts'

export type TranscriptionDockProps = { model: TranscriptionDockModel; actions: TranscriptionDockActions }

function durationLabel(durationMs: number | null) {
  if (durationMs === null) return 'Duration unavailable'
  const totalSeconds = Math.floor(durationMs / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

function stateLabel(session: TranscriptionSession) {
  if (session.state === 'failed') return 'Needs attention'
  if (session.state === 'ready') return 'Transcript ready'
  if (session.state === 'transcribing') return 'Transcribing'
  return 'Saved audio'
}

function importedDate(session: TranscriptionSession) {
  if (!session.createdAt) return ''
  const date = new Date(session.createdAt)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString()
}

export function TranscriptionDock({ model, actions }: TranscriptionDockProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const recorder = model.recording
  const recordingPhaseRef = useRef(recorder.phase)
  const stopRecordingRef = useRef(actions.stopRecording)
  const busy = model.phase === 'importing' || model.phase === 'downloading' || model.phase === 'transcribing' || model.phase === 'summarizing' || model.phase === 'cancelling-summary'
  const controlsBusy = busy || recorder.phase !== 'idle'
  const status = model.status
  const canTranscribe = status?.canTranscribe === true

  useEffect(() => {
    recordingPhaseRef.current = recorder.phase
    stopRecordingRef.current = actions.stopRecording
  }, [actions.stopRecording, recorder.phase])

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

  return (
    <section className="transcription-dock" aria-label="Local transcription">
      <div
        className={`transcription-dropzone${dragging ? ' is-dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={onDrop}
      >
        <span className="transcription-audio-icon" aria-hidden="true">♫</span>
        <strong>Transcribe an audio file</strong>
        <span>Drop it here or choose a file. Audio stays on this device.</span>
        <button type="button" className="transcription-primary" onClick={() => inputRef.current?.click()} disabled={controlsBusy}>
          Choose audio
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

      <div className={`transcription-recorder${recorder.phase === 'recording' ? ' is-recording' : ''}`}>
        <div className="transcription-recorder-heading">
          <span className="transcription-recorder-mark" aria-hidden="true">●</span>
          <div>
            <strong>Record from microphone</strong>
            <small>Saved locally as WAV, ready for transcription</small>
          </div>
          {recorder.phase === 'recording' && <span className="transcription-recorder-timer" role="timer">{recorder.duration}</span>}
          {recorder.phase === 'processing' && <span className="transcription-recorder-timer" role="status">Preparing…</span>}
        </div>
        <div className="transcription-recorder-actions">
          {recorder.phase === 'idle' && (
            <button type="button" className="transcription-record-button" onClick={() => void actions.startRecording()} disabled={busy}>
              <span aria-hidden="true">●</span> Start recording
            </button>
          )}
          {recorder.phase === 'requesting' && <span className="transcription-recorder-hint" role="status">Waiting for microphone permission…</span>}
          {recorder.phase === 'recording' && <>
            <span className="transcription-recording-activity" aria-hidden="true"><i /><i /><i /><i /><i /></span>
            <button type="button" className="transcription-record-button is-stop" onClick={actions.stopRecording}>Stop recording</button>
            <button type="button" className="transcription-recorder-quiet" onClick={actions.discardRecording}>Discard</button>
          </>}
          {recorder.phase === 'processing' && <span className="transcription-recorder-hint" role="status">Converting the recording on this device…</span>}
          {recorder.phase === 'ready' && <>
            <span className="transcription-recorder-hint">Recording ready · {recorder.duration}</span>
            <button type="button" className="transcription-record-button" onClick={() => void actions.retryRecording()} disabled={recorder.saving || busy}>
              {recorder.saving ? 'Saving…' : 'Retry recording'}
            </button>
            <button type="button" className="transcription-recorder-quiet" onClick={actions.discardRecording} disabled={recorder.saving}>Discard</button>
          </>}
        </div>
        {recorder.error && <p className="transcription-recorder-error" role="alert">{recorder.error}</p>}
      </div>

      <div className="transcription-model-status" role="status" aria-live="polite">
        <div className={`transcription-model-state${status?.modelState === 'ready' ? ' is-ready' : ''}`}>
          <span className="transcription-status-dot" aria-hidden="true" />
          <strong>{status?.modelState === 'ready' ? 'Whisper is ready' : status?.modelState === 'downloading' ? 'Downloading Whisper' : 'Whisper is not installed'}</strong>
        </div>
        {!status?.available && <p>Local transcription requires the Folio desktop app on an Apple Silicon Mac with macOS 14 or later.</p>}
        {status?.available && !status.helperAvailable && <p>Build the bundled MLX helper to enable local transcription.</p>}
        {status?.modelState === 'missing' && status.canInstall && (
          <>
            <p>Download mlx-community/whisper-large-v3-turbo (about 1.6 GB). The model runs locally.</p>
            <button type="button" className="transcription-secondary" onClick={actions.installModel} disabled={controlsBusy}>Download model</button>
          </>
        )}
        {status?.modelState === 'downloading' && (
          <div className="transcription-download-progress" aria-label={`Whisper download ${status.downloadPercent}%`}>
            <div><span style={{ width: `${status.downloadPercent}%` }} /></div>
            <small>{status.downloadPercent}% · {status.downloadedBytes.toLocaleString()} of about {status.totalBytes.toLocaleString()} bytes</small>
          </div>
        )}
      </div>

      {model.progress && <p className="transcription-progress" role="status">{model.progress}</p>}
      {(model.phase === 'summarizing' || model.phase === 'cancelling-summary') && <p className="transcription-empty">Cancel waits for the current local model request to finish; its result will be discarded and the previous summary kept.</p>}
      {model.error && <p className="transcription-error" role="alert">{model.error}</p>}

      <div className="transcription-pending">
        <div className="transcription-subheading">Audio and transcripts <span>{model.pending.length}</span></div>
        {model.pending.length === 0 ? (
          <p className="transcription-empty">Imported audio and editable transcript notes will appear here.</p>
        ) : model.pending.map((session) => {
          const processing = session.state === 'transcribing' || (busy && model.activeSession?.id === session.id && model.phase === 'transcribing')
          const summarizing = busy && model.activeSession?.id === session.id
            && (model.phase === 'summarizing' || model.phase === 'cancelling-summary')
          return (
            <article className="transcription-item" key={session.id}>
              <div className="transcription-item-heading">
                <strong title={session.fileName || 'Audio recording'}>{session.fileName || 'Audio recording'}</strong>
                <span>{stateLabel(session)}</span>
              </div>
              <small>{importedDate(session)}{session.durationMs === null ? '' : ` · ${durationLabel(session.durationMs)}`}</small>
              {session.error && <p className="transcription-item-error" role="status">{session.error}</p>}
              <div className="transcription-item-actions">
                {session.state === 'ready' ? (
                  <>
                    <button type="button" onClick={() => actions.openTranscript(session)} disabled={controlsBusy}>Open note</button>
                    <button type="button" onClick={() => actions.regenerateSummary(session)} disabled={controlsBusy}>Regenerate summary</button>
                  </>
                ) : (
                  <button type="button" onClick={() => actions.transcribe(session)} disabled={!canTranscribe || controlsBusy || processing}>
                    {session.state === 'failed' ? 'Retry' : 'Transcribe'}
                  </button>
                )}
                {processing && <button type="button" onClick={() => actions.cancel(session)}>Cancel</button>}
                {summarizing && <button type="button" onClick={() => actions.cancel(session)} disabled={model.phase === 'cancelling-summary'}>{model.phase === 'cancelling-summary' ? 'Cancelling…' : 'Cancel summary'}</button>}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
