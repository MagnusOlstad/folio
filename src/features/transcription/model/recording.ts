const MAX_WAV_BYTES = 500 * 1024 * 1024
/** Whisper's native rate; mono 16-bit at this rate is about 115 MB per hour. */
export const WAV_SAMPLE_RATE = 16_000

export type RecordingAssociation = { sourceBundleId: string | null }

/** Encode decoded audio as a browser-independent, mono, 16-bit PCM WAV (channels are averaged). */
export function encodeAudioBufferAsWav(audio: AudioBuffer): Blob {
  const sourceChannels = Math.max(1, audio.numberOfChannels)
  const channels = 1
  const bytesPerSample = 2
  const dataBytes = audio.length * channels * bytesPerSample
  if (dataBytes + 44 > MAX_WAV_BYTES) {
    throw new Error('This recording would exceed the 500 MB audio limit. Record a shorter session and try again.')
  }

  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, audio.sampleRate, true)
  view.setUint32(28, audio.sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  const inputs = Array.from({ length: sourceChannels }, (_, channel) => audio.getChannelData(channel))
  for (let frame = 0; frame < audio.length; frame += 1) {
    let mixed = 0
    for (const input of inputs) mixed += input[frame] ?? 0
    const sample = Math.max(-1, Math.min(1, mixed / sourceChannels))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += bytesPerSample
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Resamples to 16 kHz mono with an OfflineAudioContext; a no-op when the buffer already matches. */
async function toSpeechRate(audio: AudioBuffer): Promise<AudioBuffer> {
  if (audio.sampleRate === WAV_SAMPLE_RATE) return audio
  const frames = Math.max(1, Math.ceil(audio.duration * WAV_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, frames, WAV_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = audio
  source.connect(offline.destination)
  source.start()
  return offline.startRendering()
}

function createDecodingContext(): AudioContext {
  const AudioContextConstructor = window.AudioContext
  try {
    // Decoding at 16 kHz resamples while decoding, which keeps hours of audio within memory.
    return new AudioContextConstructor({ sampleRate: WAV_SAMPLE_RATE })
  } catch {
    return new AudioContextConstructor()
  }
}

export async function recordingBlobToWav(blob: Blob): Promise<Blob> {
  if (!window.AudioContext) throw new Error('This device cannot convert its recording to WAV audio.')
  const context = createDecodingContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    return encodeAudioBufferAsWav(await toSpeechRate(decoded))
  } catch (error) {
    if (error instanceof Error && error.message.includes('500 MB')) throw error
    throw new Error('The recording could not be converted to WAV. Try recording again.')
  } finally {
    await context.close().catch(() => undefined)
  }
}
