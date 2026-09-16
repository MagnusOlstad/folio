import path from 'node:path'

export const TRANSCRIPTION_STATES = ['recording', 'recorded', 'queued', 'transcribing', 'cleaning', 'ready', 'delivered', 'failed']
export const RETRYABLE_STATES = new Set(['recorded', 'queued', 'failed', 'ready'])

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
    sampleRate: manifest.sampleRate === 16000 ? 16000 : null,
    channels: manifest.channels === 1 ? 1 : null,
    draftId: typeof manifest.draftId === 'string' ? manifest.draftId : null,
    error: typeof manifest.error === 'string' ? manifest.error.slice(0, 2000) : null,
    source: manifest.source === 'desktop' ? 'desktop' : 'desktop',
    systemAudio: manifest.systemAudio === 'captured' ? 'captured' : 'unavailable',
  }
}

export function nextRetryableState(manifest) {
  if (!manifest) return null
  if (manifest.state === 'recording' || manifest.state === 'transcribing' || manifest.state === 'cleaning') return { ...manifest, state: 'failed', error: 'The previous transcription was interrupted. Retry it to continue.' }
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
