import type { ViewerDocument } from '../../../domain/types.ts'

export type TranscriptionPhase = 'idle' | 'importing' | 'downloading' | 'transcribing' | 'summarizing' | 'cancelling-summary' | 'error'
export type TranscriptionSessionState = 'recorded' | 'queued' | 'transcribing' | 'ready' | 'failed'

export type TranscriptionSession = {
  id: string
  state: TranscriptionSessionState
  draftId: string | null
  durationMs: number | null
  error: string | null
  createdAt?: string
  updatedAt?: string
  fileName?: string | null
  source?: 'file'
  sourceNoteId?: string | null
  sourceBundleId?: string | null
}

export type TranscriptionResult = {
  markdown?: string
  summary: string
  transcript: string
  generatedAt?: string
  summaryGeneratedAt?: string
}

export type TranscriptionProcessResponse = { session: TranscriptionSession; result: TranscriptionResult }

export type TranscriptionStatus = {
  model: string
  revision: string
  available: boolean
  helperAvailable: boolean
  modelState: 'ready' | 'missing' | 'downloading'
  downloadedBytes: number
  totalBytes: number
  downloadPercent: number
  canInstall: boolean
  canTranscribe: boolean
  installing: boolean
}

export type TranscriptionDraftAdapter = {
  createDraft: (content?: string) => string
  getDraftContent: (id: string) => string | undefined
  getDraftDocument: (id: string) => ViewerDocument | undefined
  updateDraftContent: (id: string, content: string) => void
  openDraft: (id: string) => void
}

export function mergeTranscriptionDraft(session: TranscriptionSession, result: TranscriptionResult) {
  const name = String(session.fileName || 'Audio recording').replace(/[\r\n]/g, ' ')
  const source = session.sourceNoteId ? `[[${session.sourceNoteId.replace(/[\r\n\]]/g, '')}]]` : 'Not linked to a source note'
  const totalSeconds = Math.floor((session.durationMs ?? 0) / 1000)
  const duration = `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
  const sections = [
    `# ${name} transcript`,
    '',
    `- Source audio: ${name}`,
    `- Imported: ${session.createdAt ? new Date(session.createdAt).toLocaleString() : 'Unknown'}`,
    `- Duration: ${session.durationMs === null ? 'Unknown' : duration}`,
    `- Source note: ${source}`,
    '',
    '## Summary',
    '',
    result.summary.trim() || 'Generate a summary from this transcript.',
    '',
    '## Transcript',
    '',
    result.transcript.trim() || '(No speech was recognized.)',
  ]
  return `${sections.join('\n').trimEnd()}\n`
}

export function replaceMarkdownSection(markdown: string, heading: string, content: string) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`)
  if (headingIndex < 0) return `${markdown.trimEnd()}\n\n## ${heading}\n\n${content.trim()}\n`
  let nextHeading = lines.findIndex((line, index) => index > headingIndex && /^##\s/.test(line))
  if (nextHeading < 0) nextHeading = lines.length
  lines.splice(headingIndex + 1, nextHeading - headingIndex - 1, '', content.trim(), '')
  return `${lines.join('\n').trimEnd()}\n`
}
