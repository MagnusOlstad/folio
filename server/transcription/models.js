import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_TRANSCRIPTION_MODEL_ID = 'whisper'

export const TRANSCRIPTION_MODELS = Object.freeze({
  whisper: Object.freeze({
    id: 'whisper',
    name: 'Whisper Large v3 Turbo',
    purpose: 'transcription',
    repository: 'mlx-community/whisper-large-v3-turbo',
    revision: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb',
    task: 'transcription',
    downloadSizeBytes: 1_610_000_000,
    requiredFiles: Object.freeze(['config.json', 'weights.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'vocab.json', 'merges.txt', 'normalizer.json', 'generation_config.json']),
  }),
  whisperlarge: Object.freeze({
    id: 'whisperlarge',
    name: 'Whisper Large v3',
    purpose: 'transcription',
    task: 'transcription',
    repository: 'mlx-community/whisper-large-v3-asr-fp16',
    revision: 'f4b9d561e7f1a5c0587726ff7ff03da2cc80fcf9',
    downloadSizeBytes: 3_090_000_000,
    requiredFiles: Object.freeze(['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'vocab.json', 'merges.txt', 'normalizer.json', 'generation_config.json']),
  }),
})

export function isTranscriptionModelId(id) {
  return typeof id === 'string' && Object.hasOwn(TRANSCRIPTION_MODELS, id)
}

export function transcriptionModelSelectionPath(modelRoot) {
  return path.join(modelRoot, 'transcription-model.json')
}

export async function readTranscriptionModelPreference(modelRoot) {
  try {
    const saved = JSON.parse(await fs.readFile(transcriptionModelSelectionPath(modelRoot), 'utf8'))
    if (isTranscriptionModelId(saved.id)) return saved.id
  } catch { /* use the default when the preference is missing or corrupt */ }
  return DEFAULT_TRANSCRIPTION_MODEL_ID
}

export async function writeTranscriptionModelPreference(modelRoot, id) {
  if (!isTranscriptionModelId(id)) {
    throw Object.assign(new Error('Choose a transcription model.'), { statusCode: 400 })
  }
  await fs.mkdir(modelRoot, { recursive: true })
  const selectionPath = transcriptionModelSelectionPath(modelRoot)
  const temporaryPath = `${selectionPath}.${randomUUID()}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify({ id }), 'utf8')
  await fs.rename(temporaryPath, selectionPath)
  return id
}
