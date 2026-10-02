import path from 'node:path'

export const TRANSCRIPTION_STATES = ['queued', 'recorded', 'transcribing', 'ready', 'failed']
export const RETRYABLE_STATES = new Set(['recorded', 'queued', 'failed', 'ready'])
export const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.aac', '.aiff', '.flac', '.m4a', '.mp3', '.wav'])

export function safeAudioFilename(value) {
  const filename = path.basename(String(value || '').replaceAll('\\', '/')).trim()
  const extension = path.extname(filename).toLowerCase()
  if (!filename || !SUPPORTED_AUDIO_EXTENSIONS.has(extension)) return null
  const safeFilename = filename.length <= 240 ? filename : `${filename.slice(0, 240 - extension.length)}${extension}`
  return { filename: safeFilename, extension }
}

export function safeTranscriptionId(value) {
  const id = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : null
}

export function transcriptionDirectory(root, id) {
  const safeId = safeTranscriptionId(id)
  if (!safeId) return null
  return path.join(root, safeId)
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const id = safeTranscriptionId(manifest.id)
  const state = String(manifest.state || '')
  if (!id || !TRANSCRIPTION_STATES.includes(state)) return null
  return {
    id,
    state,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : new Date().toISOString(),
    updatedAt: typeof manifest.updatedAt === 'string' ? manifest.updatedAt : new Date().toISOString(),
    durationMs: Number.isFinite(manifest.durationMs) ? Math.max(0, Math.round(manifest.durationMs)) : null,
    draftId: typeof manifest.draftId === 'string' ? manifest.draftId : null,
    error: typeof manifest.error === 'string' ? manifest.error.slice(0, 2000) : null,
    fileName: typeof manifest.fileName === 'string' ? manifest.fileName.slice(0, 240) : null,
    audioExtension: typeof manifest.audioExtension === 'string' && SUPPORTED_AUDIO_EXTENSIONS.has(manifest.audioExtension) ? manifest.audioExtension : '.wav',
    sourceNoteId: typeof manifest.sourceNoteId === 'string' ? manifest.sourceNoteId.slice(0, 500) : null,
    sourceBundleId: typeof manifest.sourceBundleId === 'string' ? manifest.sourceBundleId.slice(0, 200) : null,
    source: 'file',
  }
}

export function nextRetryableState(manifest) {
  if (!manifest) return null
  if (manifest.state === 'transcribing') return { ...manifest, state: 'failed', error: 'The previous transcription was interrupted. Retry it to continue.' }
  return manifest
}

export function splitTranscript(text, maxCharacters = 16_000) {
  const input = String(text || '').trim()
  if (!input) return []
  const paragraphs = input.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
  const chunks = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) {
      if (current) { chunks.push(current); current = '' }
      for (let offset = 0; offset < paragraph.length; offset += maxCharacters) chunks.push(paragraph.slice(offset, offset + maxCharacters))
      continue
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length > maxCharacters && current) { chunks.push(current); current = paragraph }
    else current = candidate
  }
  if (current) chunks.push(current)
  return chunks
}

export function markdownFromResult(result, rawTranscript, userNotes = '') {
  const summary = String(result?.summary || '').trim()
  const transcript = String(result?.transcript || rawTranscript || '').trim()
  const sections = []
  if (userNotes.trim()) sections.push('# Notes', '', userNotes.trim(), '')
  sections.push('# Summary', '', summary || 'No summary was generated.', '', '# Transcript', '', transcript || 'No transcript was recognized.')
  return `${sections.join('\n').trim()}\n`
}
