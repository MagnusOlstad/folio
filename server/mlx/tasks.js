import { OCR_MODEL_ID, OCR_TIMEOUT_MS } from './ocr-models.js'
import { CAPTION_TIMEOUT_MS, captionWorkerKey, cleanCaptionText } from './caption-models.js'
import { MODEL_DEFINITIONS } from './model-definitions.js'
import { DIARIZATION_MODEL_ID } from '../transcription/models.js'

const LONG_RUNNING_MS = 6 * 60 * 60_000

function progressReporter(onProgress) {
  let lastPercent = -1
  return (event) => {
    if (event.percent <= lastPercent) return
    lastPercent = event.percent
    onProgress?.(event.percent)
  }
}

/** Audio and image operations built on the service's serialized `run`. */
export function createMlxTasks({ run, isInstalled, modelDefinition, selectedTranscriptionModel, selectedCaptionModel }) {
  async function transcribe(audioPath, { signal, modelId = null, onProgress = null } = {}) {
    const id = modelId || await selectedTranscriptionModel()
    if (MODEL_DEFINITIONS[id]?.purpose !== 'transcription') throw new Error('The selected MLX model cannot transcribe audio.')
    return run(id, 'transcribe', { audioPath }, LONG_RUNNING_MS, signal, { unloadAfter: true, onEvent: progressReporter(onProgress) })
  }

  async function diarize(audioPath, { signal, onProgress = null } = {}) {
    return run(DIARIZATION_MODEL_ID, 'diarize', { audioPath }, LONG_RUNNING_MS, signal, { unloadAfter: true, onEvent: progressReporter(onProgress) })
  }

  async function extractText(imagePath, { signal } = {}) {
    const definition = modelDefinition(OCR_MODEL_ID)
    if (!await isInstalled(definition)) throw Object.assign(new Error('Install LightOnOCR in Settings → Models to extract text.'), { statusCode: 409 })
    const { text } = await run(OCR_MODEL_ID, 'ocr', { imagePath }, OCR_TIMEOUT_MS, signal)
    return { text: typeof text === 'string' ? text : '', modelId: OCR_MODEL_ID, model: definition.repository, revision: definition.revision }
  }

  // Captions use the chosen model's installed snapshot in a separate vision worker (see caption-models.js).
  async function captionImage(imagePath, { signal } = {}) {
    const id = await selectedCaptionModel()
    if (!id) {
      throw Object.assign(new Error('Choose a caption model in Settings → Models.'), { statusCode: 409, code: 'CAPTION_MODEL_NOT_SELECTED' })
    }
    const definition = modelDefinition(id)
    if (!await isInstalled(definition)) {
      throw Object.assign(new Error(`Install ${definition.name} in Settings → Models to describe images.`),
        { statusCode: 409, code: 'CAPTION_MODEL_NOT_INSTALLED', modelId: id })
    }
    const { text } = await run(captionWorkerKey(id), 'caption', { imagePath }, CAPTION_TIMEOUT_MS, signal)
    return { text: cleanCaptionText(text), modelId: id, model: definition.repository, revision: definition.revision }
  }

  return { transcribe, diarize, extractText, captionImage }
}
