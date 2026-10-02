const MAX_WAV_BYTES = 500 * 1024 * 1024

export type RecordingAssociation = { sourceBundleId: string | null }

/** Encode decoded microphone audio as a browser-independent, 16-bit PCM WAV. */
export function encodeAudioBufferAsWav(audio: AudioBuffer): Blob {
  const channels = audio.numberOfChannels
  const bytesPerSample = 2
  const dataBytes = audio.length * channels * bytesPerSample
  if (dataBytes + 44 > MAX_WAV_BYTES) {
    throw new Error('This recording would exceed the 500 MB audio limit. Record a shorter clip and try again.')
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
  for (let frame = 0; frame < audio.length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, audio.getChannelData(channel)[frame] ?? 0))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += bytesPerSample
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export async function recordingBlobToWav(blob: Blob): Promise<Blob> {
  const AudioContextConstructor = window.AudioContext
  if (!AudioContextConstructor) throw new Error('This device cannot convert its recording to WAV audio.')
  const context = new AudioContextConstructor()
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer())
    return encodeAudioBufferAsWav(audio)
  } catch (error) {
    if (error instanceof Error && error.message.includes('500 MB')) throw error
    throw new Error('The recording could not be converted to WAV. Try recording again.')
  } finally {
    await context.close().catch(() => undefined)
  }
}
