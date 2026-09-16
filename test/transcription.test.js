import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTranscriptionStorage } from '../server/transcription/storage.js'
import { createPcm16WavHeader, parsePcm16Wav } from '../server/transcription/wav.js'
import { createTranscriptionService } from '../server/transcription/service.js'
import { markdownFromResult, nextRetryableState, safeTranscriptionId, splitTranscript, validateManifest } from '../server/transcription/model.js'
import { createPcm16WavWriter } from '../electron/transcription/wav-writer.js'
import { MAX_PCM_CHUNK_BYTES, isSafeIdentifier, pcmChunkBuffer } from '../electron/transcription/validation.js'

test('WAV helpers require 16 kHz mono PCM and preserve chunk ordering', () => {
  const wav = Buffer.concat([createPcm16WavHeader(320), Buffer.alloc(320)])
  assert.equal(parsePcm16Wav(wav)?.durationMs, 10)
  assert.equal(parsePcm16Wav(Buffer.from('not wav')), null)
})

test('native WAV writer serializes chunks and keeps interrupted files recoverable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-native-wav-'))
  const filePath = path.join(root, 'recording.wav')
  const writer = await createPcm16WavWriter(filePath)
  const first = Buffer.from([1, 0, 2, 0])
  const second = Buffer.from([3, 0, 4, 0])
  await Promise.all([writer.append(first), writer.append(second)])
  const interrupted = await fs.readFile(filePath)
  assert.equal(parsePcm16Wav(interrupted)?.dataSize, 8)
  assert.deepEqual(interrupted.subarray(44), Buffer.concat([first, second]))
  assert.deepEqual(await writer.finalize(), { dataBytes: 8, durationMs: 0 })
  assert.equal(parsePcm16Wav(await fs.readFile(filePath))?.dataSize, 8)
})

test('native capture validation rejects traversal and oversized/non-PCM chunks', () => {
  assert.equal(isSafeIdentifier('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isSafeIdentifier('../escape'), false)
  assert.throws(() => pcmChunkBuffer(new Uint8Array(3)), /invalid size/)
  assert.throws(() => pcmChunkBuffer(new Uint8Array(MAX_PCM_CHUNK_BYTES + 2)), /invalid size/)
})

test('transcription state recovery and safe chunking are deterministic', () => {
  const interrupted = { id: '11111111-1111-4111-8111-111111111111', state: 'transcribing' }
  assert.equal(nextRetryableState(interrupted).state, 'failed')
  assert.equal(safeTranscriptionId(interrupted.id), interrupted.id)
  assert.equal(safeTranscriptionId('../escape'), null)
  const chunks = splitTranscript('one\n\ntwo\n\nthree', 7)
  assert.deepEqual(chunks, ['one', 'two', 'three'])
  assert.match(markdownFromResult({ summary: 's', transcript: 't' }, 'raw', 'user notes'), /^# Notes\n\nuser notes\n\n# Summary/)
})

test('system audio manifest field is always an explicit availability union', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-transcription-manifest-'))
  const storage = createTranscriptionStorage({ transcriptionsRoot: root })
  const captured = await storage.createSession({ systemAudio: 'captured' })
  const unavailable = await storage.createSession({ systemAudio: false })
  assert.equal(captured.systemAudio, 'captured')
  assert.equal((await storage.readManifest(captured.id)).systemAudio, 'captured')
  assert.equal(unavailable.systemAudio, 'unavailable')
  assert.equal(validateManifest({ ...captured, systemAudio: true }).systemAudio, 'unavailable')
})

test('fake whisper job writes raw text, cleans it, and becomes ready idempotently', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-transcription-'))
  const whisperPath = path.join(root, 'whisper-cli')
  const modelPath = path.join(root, 'ggml.bin')
  await fs.writeFile(whisperPath, '')
  await fs.writeFile(modelPath, '')
  const runtime = {
    transcriptionsRoot: path.join(root, 'transcriptions'),
    whisperPath,
    whisperModelPath: modelPath,
    classifierModel: 'classifier:latest',
    warmKeepAlive: '1h',
    ollamaUrl: 'http://127.0.0.1:11434',
    hasOllamaModel: () => true,
    ollamaRequest: async (endpoint) => endpoint === '/api/tags' ? { models: [{ name: 'classifier:latest' }] } : { message: { content: JSON.stringify({ summary: 'A factual summary', transcript: 'A cleaned transcript', notes: '' }) } },
  }
  runtime.transcriptionStorage = createTranscriptionStorage(runtime)
  runtime.transcriptionRunner = async ({ outputPrefix }) => { await fs.writeFile(`${outputPrefix}.txt`, 'um A cleaned transcript\n') }
  const service = createTranscriptionService(runtime)
  const session = await runtime.transcriptionStorage.createSession()
  await fs.writeFile(runtime.transcriptionStorage.filePath(session.id, 'recording.wav'), Buffer.concat([createPcm16WavHeader(0)]))
  await service.markRecorded(session.id, 1000)
  const first = await service.process(session.id)
  assert.equal(first.session.state, 'ready')
  assert.equal(first.result.summary, 'A factual summary')
  const second = await service.process(session.id)
  assert.equal(second.session.state, 'ready')
  assert.equal((await runtime.transcriptionStorage.readManifest(session.id)).state, 'ready')
})
