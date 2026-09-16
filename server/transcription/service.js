import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSerialQueue } from '../core/queue.js'
import { markdownFromResult, splitTranscript } from './model.js'

const cleanSchema = {
  type: 'object', additionalProperties: false,
  properties: { summary: { type: 'string' }, transcript: { type: 'string' }, notes: { type: 'string' } },
  required: ['summary', 'transcript', 'notes'],
}

function executableExists(filePath) {
  return fs.access(filePath).then(() => true, () => false)
}

function runWhisper({ executable, model, wavPath, outputPrefix, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-m', model, '-f', wavPath, '-l', 'auto', '-otxt', '-of', outputPrefix, '-np'], { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-8000) })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        const error = new Error(`Whisper transcription failed (${code ?? 'unknown'}).${stderr ? ` ${stderr.trim()}` : ''}`)
        error.code = 'WHISPER_FAILED'
        error.stdout = stdout
        reject(error)
      } else resolve({ stdout, stderr })
    })
  })
}

async function modelStatus(runtime, whisperPath, modelPath) {
  const [runtimeAvailable, modelAvailable] = await Promise.all([executableExists(whisperPath), executableExists(modelPath)])
  let ollama = 'offline'
  let ollamaModel = 'unknown'
  if (runtime.ollamaRequest) {
    try {
      const tags = await runtime.ollamaRequest('/api/tags', null, 3_000)
      ollama = 'online'
      const names = Array.isArray(tags?.models) ? tags.models.map((item) => String(item.name || '')) : []
      ollamaModel = runtime.hasOllamaModel?.(runtime.classifierModel, names) ? 'ready' : 'missing'
    } catch { /* offline is an actionable status, not a process failure */ }
  }
  return { available: runtimeAvailable && modelAvailable && ollama === 'online' && ollamaModel === 'ready', runtime: runtimeAvailable ? 'ready' : 'missing', model: modelAvailable ? 'ready' : 'missing', ollama, ollamaModel, whisperPath, modelPath }
}

async function summarizePieces(runtime, pieces) {
  let current = pieces.filter(Boolean).map((piece) => String(piece).trim()).filter(Boolean)
  while (current.length > 1) {
    const groups = []
    let group = ''
    for (const piece of current) {
      const candidate = group ? `${group}\n- ${piece}` : `- ${piece}`
      if (group && candidate.length > 7_000) { groups.push(group); group = `- ${piece}` } else group = candidate
    }
    if (group) groups.push(group)
    const next = []
    for (const input of groups) {
      const response = await runtime.ollamaRequest('/api/chat', {
        model: runtime.classifierModel, keep_alive: runtime.warmKeepAlive, stream: false, format: cleanSchema, options: { temperature: 0 },
        messages: [{ role: 'system', content: 'Create a concise factual summary from these transcript summaries. Preserve names, numbers, dates, decisions, and uncertainty. Do not add speaker labels or facts.' }, { role: 'user', content: `<summaries>\n${input}\n</summaries>` }],
      })
      const parsed = JSON.parse(response?.message?.content || '{}')
      next.push(String(parsed.summary || '').trim() || input.slice(0, 500))
    }
    current = next
  }
  return current[0] || ''
}

async function cleanTranscript(runtime, rawTranscript) {
  const chunks = splitTranscript(rawTranscript)
  if (!chunks.length) return { summary: 'No speech was recognized.', transcript: '', notes: '' }
  const cleaned = []
  const summaries = []
  const observations = []
  for (const chunk of chunks) {
    const response = await runtime.ollamaRequest('/api/chat', {
      model: runtime.classifierModel,
      keep_alive: runtime.warmKeepAlive,
      stream: false,
      format: cleanSchema,
      options: { temperature: 0 },
      messages: [{ role: 'system', content: 'Clean a speech transcript. Preserve language, factual claims, names, numbers, dates, decisions, and uncertainty. Remove filler and recognition artifacts. Never invent facts or speaker labels; do not identify speakers unless the transcript explicitly does. Return a concise summary, the faithful cleaned transcript, and any notes about unintelligible words.' }, { role: 'user', content: `<transcript-chunk>\n${chunk}\n</transcript-chunk>` }],
    })
    const parsed = JSON.parse(response?.message?.content || '{}')
    cleaned.push(String(parsed.transcript || chunk).trim())
    summaries.push(String(parsed.summary || '').trim())
    if (parsed.notes) observations.push(String(parsed.notes).trim())
  }
  const summary = await summarizePieces(runtime, summaries)
  return { summary: summary || 'No summary was generated.', transcript: cleaned.join('\n\n'), observations: observations.join('\n') }
}

export function createTranscriptionService(runtime) {
  const queue = createSerialQueue()
  const whisperPath = runtime.whisperPath
  const modelPath = runtime.whisperModelPath
  const storage = runtime.transcriptionStorage
  async function status() { return modelStatus(runtime, whisperPath, modelPath) }
  async function process(id) {
    return queue(async () => {
      const session = await storage.readManifest(id)
      if (!session) { const error = new Error('Transcription session not found.'); error.status = 404; throw error }
      if (session.state === 'delivered') return { session, result: await storage.readResult(id) }
      if (session.state === 'ready') return { session, result: await storage.readResult(id) }
      async function unavailable(message, code, status = 503) {
        const error = new Error(message)
        error.code = code
        error.status = status
        await storage.writeManifest({ ...session, state: 'failed', error: message })
        throw error
      }
      const dependencies = await status()
      if (dependencies.runtime === 'missing') await unavailable('Whisper runtime is unavailable. Prepare the desktop runtime before processing.', 'RUNTIME_MISSING')
      if (dependencies.model === 'missing') await unavailable(`Whisper model is unavailable at ${modelPath}.`, 'MODEL_MISSING')
      if (dependencies.ollama !== 'online' || dependencies.ollamaModel !== 'ready') await unavailable('Ollama classifier is unavailable or its configured model is not installed.', 'OLLAMA_UNAVAILABLE')
      const wavPath = storage.filePath(id, 'recording.wav')
      if (!(await storage.hasRecording(id))) await unavailable('Recording audio is missing.', 'RECORDING_MISSING', 409)
      await storage.writeManifest({ ...session, state: 'transcribing', error: null })
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-whisper-'))
      const prefix = path.join(tempRoot, 'transcript')
      try {
        const runner = runtime.transcriptionRunner || runWhisper
        await runner({ executable: whisperPath, model: modelPath, wavPath, outputPrefix: prefix })
        const rawPath = `${prefix}.txt`
        const rawTranscript = runtime.transcriptionRunner ? await storage.readRawTranscript(id) || await fs.readFile(rawPath, 'utf8').catch(() => '') : await fs.readFile(rawPath, 'utf8')
        await fs.writeFile(storage.filePath(id, 'raw-transcript.txt'), rawTranscript, 'utf8')
        await storage.writeManifest({ ...(await storage.readManifest(id)), state: 'cleaning', error: null })
        const result = await cleanTranscript(runtime, rawTranscript)
        await storage.writeResult(id, { ...result, markdown: markdownFromResult(result, rawTranscript), generatedAt: new Date().toISOString() })
        const ready = await storage.writeManifest({ ...(await storage.readManifest(id)), state: 'ready', error: null })
        return { session: ready, result: await storage.readResult(id) }
      } catch (error) {
        const failed = await storage.writeManifest({ ...(await storage.readManifest(id) || session), state: 'failed', error: error instanceof Error ? error.message : 'Transcription failed.' })
        error.session = failed
        throw error
      } finally { await fs.rm(tempRoot, { recursive: true, force: true }) }
    })
  }
  async function markRecorded(id, durationMs) {
    const session = await storage.readManifest(id)
    if (!session) { const error = new Error('Transcription session not found.'); error.status = 404; throw error }
    return storage.writeManifest({ ...session, state: 'recorded', durationMs: Number.isFinite(durationMs) ? durationMs : session.durationMs })
  }
  async function markDelivered(id) {
    const session = await storage.readManifest(id)
    if (!session) { const error = new Error('Transcription session not found.'); error.status = 404; throw error }
    return storage.writeManifest({ ...session, state: 'delivered', error: null })
  }
  async function getSession(id) {
    const session = await storage.readManifest(id)
    if (!session) return null
    return { session, result: await storage.readResult(id) }
  }
  return { status, process, markRecorded, markDelivered, getSession, list: storage.listSessions, recoverInterrupted: storage.recoverInterrupted, storage }
}
