const MAX_IDENTIFIER_LENGTH = 128
export const MAX_PCM_CHUNK_BYTES = 2 * 1024 * 1024

export function isSafeIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
}

export function requireSafeIdentifier(value, name = 'ID') {
  if (!isSafeIdentifier(value)) throw new TypeError(`Invalid ${name}.`)
  return value
}

export function requireSender(event, getWindow) {
  const window = getWindow()
  if (!window || window.isDestroyed() || event?.sender?.id !== window.webContents.id) {
    throw new Error('Unauthorized renderer sender.')
  }
  return event.sender
}

export function pcmChunkBuffer(value) {
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
    throw new TypeError('PCM chunk must be an ArrayBuffer or Uint8Array.')
  }
  const buffer = value instanceof ArrayBuffer
    ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_PCM_CHUNK_BYTES || buffer.byteLength % 2 !== 0) {
    throw new RangeError('PCM chunk has an invalid size.')
  }
  return buffer
}

export function optionalDraftId(value) {
  if (value === null || value === undefined || value === '') return null
  return requireSafeIdentifier(value, 'draft ID')
}
