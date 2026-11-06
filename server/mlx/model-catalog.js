import { OCR_MODELS } from './ocr-models.js'
import { ENTITY_MODEL_BYTES, ENTITY_MODEL_ID, ENTITY_MODEL_REPOSITORY, ENTITY_MODEL_REVISION } from './entities-model.js'
import { TRANSCRIPTION_MODELS } from '../transcription/models.js'

const MODEL_DEFINITIONS = Object.freeze({
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
  [ENTITY_MODEL_ID]: {
    id: ENTITY_MODEL_ID, name: 'GLiNER 2.5 Multi', purpose: 'entities',
    repository: ENTITY_MODEL_REPOSITORY, revision: ENTITY_MODEL_REVISION,
    task: 'entities', downloadSizeBytes: ENTITY_MODEL_BYTES,
  },
})

export function createMlxModelCatalog() {
  const externalModels = new Map()
  const externalModelAdapters = new Map()

  function modelDefinition(id) {
    const model = MODEL_DEFINITIONS[id]
    if (!model) throw Object.assign(new Error('Unknown MLX model.'), { statusCode: 404 })
    return model
  }

  function registerExternalModel(id, adapter) {
    if (MODEL_DEFINITIONS[id]?.purpose !== 'transcription' || !adapter) throw new Error('Invalid external MLX model adapter.')
    if (!externalModels.has(id)) externalModels.set(id, adapter)
    const adapters = externalModelAdapters.get(id) || new Set()
    adapters.add(adapter)
    externalModelAdapters.set(id, adapters)
    return () => { if (externalModels.get(id) === adapter) externalModels.delete(id) }
  }

  function externalModel(id) {
    return externalModels.get(id)
  }

  function adapterClosures() {
    return [...externalModelAdapters.values()].flatMap((adapters) => [...adapters])
  }

  return { definitions: MODEL_DEFINITIONS, modelDefinition, registerExternalModel, externalModel, adapterClosures }
}

export function createEntityModelAvailabilityEvents() {
  const listeners = new Set()

  function emit(installed) {
    for (const listener of listeners) {
      try { void Promise.resolve(listener({ installed })).catch((error) => console.error(`Entity model availability listener failed: ${error.message}`)) }
      catch (error) { console.error(`Entity model availability listener failed: ${error.message}`) }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Entity model availability listener must be a function.')
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { emit, subscribe }
}
