import { OCR_MODELS } from './ocr-models.js'
import { DIARIZATION_MODELS, TRANSCRIPTION_MODELS } from '../transcription/models.js'

export const MODEL_DEFINITIONS = Object.freeze({
  gemma4: {
    id: 'gemma4', name: 'Gemma 4 E4B', purpose: 'generation',
    repository: 'mlx-community/gemma-4-e4b-it-4bit', revision: '475b9088d29754a3379866cf5aeb6b41acd313c2',
    task: 'generation', downloadSizeBytes: 5_180_000_000,
  },
  qwen35: {
    id: 'qwen35', name: 'Qwen 3.5 4B (4-bit)', purpose: 'generation',
    repository: 'mlx-community/Qwen3.5-4B-4bit', revision: '0e7ffd5c629ef7719d4cbc04069232580bfa9d9c',
    task: 'generation', downloadSizeBytes: 3_060_000_000,
  },
  llama32: {
    id: 'llama32', name: 'Llama 3.2 3B Instruct (4-bit)', purpose: 'generation',
    repository: 'mlx-community/Llama-3.2-3B-Instruct-4bit', revision: '7f0dc925e0d0afb0322d96f9255cfddf2ba5636e',
    task: 'generation', downloadSizeBytes: 1_810_000_000,
  },
  embeddinggemma: {
    id: 'embeddinggemma', name: 'EmbeddingGemma', purpose: 'embeddings',
    repository: 'mlx-community/embeddinggemma-300m-4bit', revision: '5d9ef074df3957afc5c77127f208fddbc3c54187',
    task: 'embedding', downloadSizeBytes: 212_000_000,
  },
  ...OCR_MODELS,
  ...TRANSCRIPTION_MODELS,
  ...DIARIZATION_MODELS,
})
