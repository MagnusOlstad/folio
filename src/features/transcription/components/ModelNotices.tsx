import type { TranscriptionStatus } from '../model/types.ts'

type ModelNoticesProps = {
  status: TranscriptionStatus | null
  selectedModelName: string
  speakerOffer: boolean
  controlsBusy: boolean
  onInstallModel: () => void
  onInstallSpeakerModel: () => void
}

function Progress({ label, percent, downloaded, total }: { label: string; percent: number; downloaded: number; total: number }) {
  return (
    <div className="transcription-download-progress" aria-label={label}>
      <div><span style={{ width: `${percent}%` }} /></div>
      <small>{percent}% · {downloaded.toLocaleString()} of about {total.toLocaleString()} bytes</small>
    </div>
  )
}

/** Compact status lines for the Whisper model and the speaker model; nothing while everything is ready. */
export function ModelNotices({ status, selectedModelName, speakerOffer, controlsBusy, onInstallModel, onInstallSpeakerModel }: ModelNoticesProps) {
  const speakers = status?.diarization
  const whisperReady = status?.modelState === 'ready'
  return (
    <>
      {!whisperReady && (
        <div className="transcription-notice" role="status" aria-live="polite">
          <div className="transcription-model-state">
            <span className="transcription-status-dot" aria-hidden="true" />
            <strong>{status?.modelState === 'downloading' ? `Downloading ${selectedModelName}` : `${selectedModelName} is not installed`}</strong>
          </div>
          {!status?.available && <p>Local transcription requires the FolioNotes desktop app on an Apple Silicon Mac with macOS 14 or later.</p>}
          {status?.available && !status.helperAvailable && <p>Build the bundled MLX helper to enable local transcription.</p>}
          {status?.modelState === 'missing' && status.canInstall && <>
            <p>Download {status.model} (about {(status.totalBytes / 1_000_000_000).toFixed(1)} GB). The model runs locally.</p>
            <button type="button" className="transcription-secondary" onClick={onInstallModel} disabled={controlsBusy}>Download {selectedModelName}</button>
          </>}
          {status?.modelState === 'downloading' && (
            <Progress label={`${selectedModelName} download ${status.downloadPercent}%`} percent={status.downloadPercent} downloaded={status.downloadedBytes} total={status.totalBytes} />
          )}
        </div>
      )}
      {speakers && speakerOffer && (
        <div className="transcription-notice transcription-speaker-model" role="status" aria-live="polite">
          <div className="transcription-model-state">
            <span className="transcription-status-dot" aria-hidden="true" />
            <strong>{speakers.modelState === 'downloading' ? `Downloading ${speakers.modelName}` : `${speakers.modelName} is not installed`}</strong>
          </div>
          {speakers.modelState === 'missing' && <>
            <p>Speaker labels need {speakers.model} (about {Math.round(speakers.totalBytes / 1_000_000)} MB). It runs locally and is only downloaded when you ask.</p>
            <button type="button" className="transcription-secondary" onClick={onInstallSpeakerModel} disabled={controlsBusy || !speakers.canInstall}>Download {speakers.modelName}</button>
          </>}
          {speakers.modelState === 'downloading' && (
            <Progress label={`${speakers.modelName} download ${speakers.downloadPercent}%`} percent={speakers.downloadPercent} downloaded={speakers.downloadedBytes} total={speakers.totalBytes} />
          )}
        </div>
      )}
    </>
  )
}
