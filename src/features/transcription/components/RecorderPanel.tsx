import type { TranscriptionDockActions, TranscriptionDockModel } from '../hooks/useTranscription.ts'
import { sourceNoun } from '../model/recording-source.ts'

type RecorderPanelProps = { recorder: TranscriptionDockModel['recording']; actions: TranscriptionDockActions; busy: boolean }

function Meter({ label, level, silentMessage }: { label: string; level: number; silentMessage: string | null }) {
  return (
    <div className="transcription-meter">
      <span className="transcription-meter-label">{label}</span>
      <span
        className="transcription-meter-bar"
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={level}
      >
        <i style={{ transform: `scaleX(${level})` }} />
      </span>
      {silentMessage && <span className="transcription-meter-warning" role="status">{silentMessage}</span>}
    </div>
  )
}

/** Compact recorder states (requesting, recording, processing, ready), shown only while one is active. */
export function RecorderPanel({ recorder, actions, busy }: RecorderPanelProps) {
  if (recorder.phase === 'idle' && !recorder.error) return null
  const { source } = recorder
  const showMic = source !== 'system'
  const showSystem = source !== 'microphone'
  const title = recorder.phase === 'recording' ? `Recording ${sourceNoun(source)}` : `${sourceNoun(source)} recording`
  const permission = source === 'system' ? 'system audio' : source === 'mixed' ? 'microphone and system audio' : 'microphone'
  const canOpenSettings = recorder.systemAudioBlocked && typeof window.folio?.openSystemAudioSettings === 'function'
  return (
    <div className={`transcription-recorder${recorder.phase === 'recording' ? ' is-recording' : ''}`}>
      <div className="transcription-recorder-heading">
        <span className="transcription-recorder-mark" aria-hidden="true">●</span>
        <strong>{title.charAt(0).toUpperCase() + title.slice(1)}</strong>
        {recorder.phase === 'recording' && <span className="transcription-recorder-timer" role="timer">{recorder.duration}</span>}
        {recorder.phase === 'processing' && <span className="transcription-recorder-timer" role="status">Preparing…</span>}
      </div>
      {recorder.phase === 'recording' && (showSystem || recorder.silent.mic) && (
        <div className="transcription-meters">
          {showMic && <Meter label="Mic" level={recorder.levels.mic} silentMessage={recorder.silent.mic ? 'Microphone is silent' : null} />}
          {showSystem && <Meter label="System" level={recorder.levels.system} silentMessage={recorder.silent.system ? 'No system audio yet — is the meeting playing on this Mac?' : null} />}
        </div>
      )}
      {recorder.phase === 'recording' && source === 'mixed' && (
        <p className="transcription-recorder-hint">Use headphones so the meeting isn't recorded twice.</p>
      )}
      <div className="transcription-recorder-actions">
        {recorder.phase === 'requesting' && <span className="transcription-recorder-hint" role="status">Waiting for {permission} permission…</span>}
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
      {canOpenSettings && (
        <div className="transcription-recorder-actions">
          <button type="button" className="transcription-recorder-quiet" onClick={() => void window.folio?.openSystemAudioSettings?.()}>Open System Settings</button>
        </div>
      )}
    </div>
  )
}
