import { readStorageItem, writeStorageItem } from '../../../lib/storage.ts'

export type RecordingSource = 'microphone' | 'system' | 'mixed'

export const RECORDING_SOURCE_KEY = 'folio:recording-source'

export const RECORDING_SOURCE_OPTIONS: ReadonlyArray<{ value: RecordingSource; label: string }> = [
  { value: 'microphone', label: 'Microphone' },
  { value: 'system', label: 'System audio' },
  { value: 'mixed', label: 'Microphone + system audio' },
]

export function parseRecordingSource(value: unknown): RecordingSource | null {
  return value === 'microphone' || value === 'system' || value === 'mixed' ? value : null
}

/** System audio capture is offered only by the desktop shell on supported platforms. */
export function systemAudioSupported(): boolean {
  return typeof window !== 'undefined' && window.folio?.systemAudio?.supported === true
}

/** The remembered source; without system audio support it is always the microphone. */
export function loadRecordingSource(): RecordingSource {
  if (!systemAudioSupported()) return 'microphone'
  return parseRecordingSource(readStorageItem(RECORDING_SOURCE_KEY)) ?? 'mixed'
}

export function saveRecordingSource(source: RecordingSource): void {
  writeStorageItem(RECORDING_SOURCE_KEY, source)
}

export function sourceNoun(source: RecordingSource): string {
  return source === 'microphone' ? 'microphone' : source === 'system' ? 'system audio' : 'microphone and system audio'
}

export const SYSTEM_AUDIO_UNAVAILABLE_MESSAGE =
  "System audio isn't available. Allow FolioNotes under Screen & System Audio Recording in System Settings, then try again."
