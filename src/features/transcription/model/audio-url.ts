import type { TranscriptionSession } from './types.ts'

/** Audio elements cannot send the bundle header, so the bundle travels in the query string. */
export function transcriptionAudioUrl(session: Pick<TranscriptionSession, 'id' | 'sourceBundleId'>) {
  const base = `/api/transcriptions/${encodeURIComponent(session.id)}/audio`
  return session.sourceBundleId ? `${base}?bundle=${encodeURIComponent(session.sourceBundleId)}` : base
}
