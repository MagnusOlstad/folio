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

/**
 * Sortformer speaker diarization is a separate, optional download (never a Whisper choice).
 *
 * The Hugging Face commit hash for this repository could not be resolved when the feature was
 * written (no access to huggingface.co). `UNRESOLVED_DIARIZATION_REVISION` is a marker, not a
 * commit: install and diarization stay disabled until it is replaced by the real 40-character
 * hash. Keep it in sync with `SortformerVariant.unresolvedRevision` in
 * experiments/mlx-swift/Sources/folio-mlx/main.swift. `requiredFiles` and the size are likewise
 * unverified estimates for the fp16 checkpoint.
 */
export const UNRESOLVED_DIARIZATION_REVISION = 'UNRESOLVED-SORTFORMER-REVISION'
export const DIARIZATION_MODEL_ID = 'sortformer'
export const DIARIZATION_MODELS = Object.freeze({
  [DIARIZATION_MODEL_ID]: Object.freeze({
    id: DIARIZATION_MODEL_ID,
    name: 'Sortformer Speaker Labels',
    purpose: 'diarization',
    repository: 'mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16',
    revision: UNRESOLVED_DIARIZATION_REVISION,
    task: 'diarization',
    downloadSizeBytes: 250_000_000,
    maxSpeakers: 4,
    requiredFiles: Object.freeze(['config.json', 'model.safetensors']),
  }),
})

export function isDiarizationRevisionPinned(model = DIARIZATION_MODELS[DIARIZATION_MODEL_ID]) {
  return /^[0-9a-f]{40}$/.test(model.revision)
}

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
