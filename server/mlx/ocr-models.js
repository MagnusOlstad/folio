export const OCR_MODEL_ID = 'lightonocr'
export const OCR_TIMEOUT_MS = 5 * 60_000

export const OCR_MODELS = Object.freeze({
  [OCR_MODEL_ID]: Object.freeze({
    id: OCR_MODEL_ID, name: 'LightOnOCR 3 1B', purpose: 'ocr',
    repository: 'lightonai/LightOnOCR-3-1B', revision: '23d544085c886bbdace647bcfab91203299417e2',
    task: 'ocr', downloadSizeBytes: 2_020_000_000,
  }),
})

export function cancellationError(definition) {
  if (definition.purpose === 'ocr') return Object.assign(new Error('Text extraction was cancelled.'), { code: 'OCR_CANCELLED' })
  if (definition.purpose === 'entities') return Object.assign(new Error('Entity extraction was cancelled. Entity data remains available and can be retried.'), { code: 'ENTITY_EXTRACTION_CANCELLED' })
  return Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' })
}
