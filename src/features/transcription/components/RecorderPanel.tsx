import type { TranscriptionDockActions, TranscriptionDockModel } from '../hooks/useTranscription.ts'

type RecorderPanelProps = { recorder: TranscriptionDockModel['recording']; actions: TranscriptionDockActions; busy: boolean }

/** Compact recorder states (requesting, recording, processing, ready), shown only while one is active. */
export function RecorderPanel({ recorder, actions, busy }: RecorderPanelProps) {
  if (recorder.phase === 'idle' && !recorder.error) return null
  return (
    <div className={`transcription-recorder${recorder.phase === 'recording' ? ' is-recording' : ''}`}>
      <div className="transcription-recorder-heading">
        <span className="transcription-recorder-mark" aria-hidden="true">●</span>
        <strong>{recorder.phase === 'recording' ? 'Recording from microphone' : 'Microphone recording'}</strong>
        {recorder.phase === 'recording' && <span className="transcription-recorder-timer" role="timer">{recorder.duration}</span>}
        {recorder.phase === 'processing' && <span className="transcription-recorder-timer" role="status">Preparing…</span>}
      </div>
      <div className="transcription-recorder-actions">
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
  )
}
