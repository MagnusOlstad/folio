export function parsePcm16Wav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > buffer.length) return null
    if (id === 'fmt ' && format === null && size >= 16) format = { audioFormat: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bitsPerSample: buffer.readUInt16LE(start + 14) }
    if (id === 'data' && data === null) data = { offset: start, size }
    offset = end + (size % 2)
  }
  if (!format || !data || format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bitsPerSample !== 16) return null
  return { ...format, dataOffset: data.offset, dataSize: data.size, durationMs: Math.round(data.size / (format.sampleRate * format.channels * 2) * 1000) }
}

export function createPcm16WavHeader(dataBytes) {
  const size = Math.max(0, Math.floor(dataBytes))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + size, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(size, 40)
  return header
}
