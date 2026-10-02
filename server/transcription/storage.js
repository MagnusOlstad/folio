import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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
    if (!['session.json', 'result.json'].includes(name)
      && !/^recording\.(aac|aiff|flac|m4a|mp3|wav)$/.test(name)) throw new Error('Invalid transcription file.')
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
  async function createSession({ id = crypto.randomUUID(), draftId = null, fileName = null, audioExtension = '.wav', sourceNoteId = null, sourceBundleId = null, durationMs = null } = {}) {
    const now = new Date().toISOString()
    return writeManifest({ id, state: 'queued', createdAt: now, updatedAt: now, durationMs, draftId, source: 'file', fileName, audioExtension, sourceNoteId, sourceBundleId, error: null })
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
  function recordingPath(session) { return filePath(session.id, `recording${session.audioExtension || '.wav'}`) }
  async function writeAudio(id, extension, source, maxBytes = 500 * 1024 * 1024) {
    const target = filePath(id, `recording${extension}`)
    const temporary = `${target}.${process.pid}.uploading`
    let size = 0
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > maxBytes) callback(Object.assign(new Error('Audio files must be 500 MB or smaller.'), { status: 413 }))
      else callback(null, chunk)
    } })
    try {
      await fs.mkdir(directory(id), { recursive: true })
      await pipeline(source, limiter, createWriteStream(temporary, { flags: 'wx' }))
      if (!size) throw new Error('The audio file is empty.')
      await fs.rename(temporary, target)
      return size
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }
  async function hasRecording(session) { try { await fs.access(recordingPath(session)); return true } catch { return false } }
  return { directory, filePath, recordingPath, writeManifest, readManifest, createSession, writeAudio, writeResult, readResult, listSessions, recoverInterrupted, hasRecording, retryableStates: RETRYABLE_STATES }
}
