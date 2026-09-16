import fs from 'node:fs/promises'
import { createPcm16WavHeader } from '../../server/transcription/wav.js'

/**
 * Streams PCM16 mono samples into a valid 16 kHz WAV file. The file is opened
 * once and chunks are written in order; only the 44-byte header is retained.
 */
export async function createPcm16WavWriter(filePath) {
  const handle = await fs.open(filePath, 'w+')
  let dataBytes = 0
  let closed = false
  let operation = Promise.resolve()

  await handle.write(createPcm16WavHeader(0), 0, 44, 0)

  function enqueue(task) {
    const next = operation.then(task)
    operation = next.catch(() => {})
    return next
  }

  function append(chunk) {
    return enqueue(async () => {
      if (closed) throw new Error('The WAV writer is closed.')
      if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length % 2 !== 0) {
        throw new TypeError('PCM16 chunks must be non-empty buffers with an even byte length.')
      }
      await handle.write(chunk, 0, chunk.length, 44 + dataBytes)
      dataBytes += chunk.length
      // Keep an interrupted recording structurally valid for recovery. Each
      // completed chunk advertises the bytes already on disk.
      await handle.write(createPcm16WavHeader(dataBytes), 0, 44, 0)
    })
  }

  function finalize() {
    return enqueue(async () => {
      if (closed) return { dataBytes, durationMs: Math.round(dataBytes / 32) }
      closed = true
      await handle.write(createPcm16WavHeader(dataBytes), 0, 44, 0)
      await handle.close()
      return { dataBytes, durationMs: Math.round(dataBytes / 32) }
    })
  }

  function abort() {
    return enqueue(async () => {
      if (!closed) {
        closed = true
        await handle.close().catch(() => {})
      }
      await fs.rm(filePath, { force: true })
    })
  }

  return { append, finalize, abort, get dataBytes() { return dataBytes }, get closed() { return closed } }
}
