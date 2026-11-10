import { reconcileSpeakersSection, resultSpeakerNumbers } from './speakers.ts'
import { replaceMarkdownSection, type TranscriptionResult } from './types.ts'

/**
 * Applies a fresh transcript to an existing draft: only the `## Transcript` section is replaced, and
 * `## Speakers` gains definitions for newly appearing speakers while keeping every line already there.
 * The title, summary, and any other text are left as they are.
 */
export function applyRetranscription(markdown: string, result: TranscriptionResult) {
  const transcript = result.transcript.trim() || '(No speech was recognized.)'
  const withTranscript = replaceMarkdownSection(markdown, 'Transcript', transcript)
  return reconcileSpeakersSection(withTranscript, resultSpeakerNumbers(result))
}
