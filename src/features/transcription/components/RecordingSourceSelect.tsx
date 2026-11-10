import { parseRecordingSource, RECORDING_SOURCE_OPTIONS, type RecordingSource } from '../model/recording-source.ts'

type RecordingSourceSelectProps = { source: RecordingSource; disabled: boolean; onChange: (source: RecordingSource) => void }

/** Source picker shown only when the desktop shell can capture system audio. */
export function RecordingSourceSelect({ source, disabled, onChange }: RecordingSourceSelectProps) {
  return (
    <label className="transcription-source">
      <span>Record</span>
      <select
        value={source}
        disabled={disabled}
        onChange={(event) => {
          const next = parseRecordingSource(event.currentTarget.value)
          if (next) onChange(next)
        }}
      >
        {RECORDING_SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}
