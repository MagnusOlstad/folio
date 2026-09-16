import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { RETRYABLE_STATES, nextRetryableState, safeTranscriptionId, transcriptionDirectory, validateManifest } from './model.js'

async function atomicWrite(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await fs.rename(temporaryPath, filePath)
}

export function createTranscriptionStorage(runtime) {
  const { transcriptionsRoot } = runtime
  function directory(id) {
    const value = transcriptionDirectory(transcriptionsRoot, id)
    if (!value) throw new Error('Invalid transcription ID.')
    return value
  }
  function filePath(id, name) {
    if (!['session.json', 'recording.wav', 'raw-transcript.txt', 'result.json'].includes(name)) throw new Error('Invalid transcription file.')
    return path.join(directory(id), name)
  }
  async function writeManifest(manifest) {
    const safe = validateManifest(manifest)
    if (!safe) throw new Error('Invalid transcription manifest.')
    safe.updatedAt = new Date().toISOString()
    await fs.mkdir(directory(safe.id), { recursive: true })
    await atomicWrite(filePath(safe.id, 'session.json'), safe)
    return safe
  }
  async function readManifest(id) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath(id, 'session.json'), 'utf8'))
      return validateManifest(parsed)
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  }
  async function createSession({ id = crypto.randomUUID(), draftId = null, systemAudio = 'unavailable' } = {}) {
    const now = new Date().toISOString()
    return writeManifest({ id, state: 'recording', createdAt: now, updatedAt: now, durationMs: null, sampleRate: 16000, channels: 1, draftId, source: 'desktop', systemAudio, error: null })
  }
  async function writeResult(id, result) { await atomicWrite(filePath(id, 'result.json'), result); return result }
  async function readResult(id) {
    try { return JSON.parse(await fs.readFile(filePath(id, 'result.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error }
  }
  async function listSessions() {
    await fs.mkdir(transcriptionsRoot, { recursive: true })
    const entries = await fs.readdir(transcriptionsRoot, { withFileTypes: true })
    const sessions = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeTranscriptionId(entry.name)) continue
      const manifest = await readManifest(entry.name)
      if (manifest) sessions.push(manifest)
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }
  async function recoverInterrupted() {
    const sessions = await listSessions()
    const updated = []
    for (const session of sessions) {
      const next = nextRetryableState(session)
      if (next.state !== session.state) await writeManifest(next)
      updated.push(next)
    }
    return updated
  }
  async function readRawTranscript(id) {
    try { return await fs.readFile(filePath(id, 'raw-transcript.txt'), 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error }
  }
  async function readRecording(id) { return fs.readFile(filePath(id, 'recording.wav')) }
  async function hasRecording(id) { try { await fs.access(filePath(id, 'recording.wav')); return true } catch { return false } }
  return { directory, filePath, writeManifest, readManifest, createSession, writeResult, readResult, listSessions, recoverInterrupted, readRawTranscript, readRecording, hasRecording, retryableStates: RETRYABLE_STATES }
}
