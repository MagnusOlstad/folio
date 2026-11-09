import { SYSTEM_AUDIO_UNAVAILABLE_MESSAGE, type RecordingSource } from './recording-source.ts'

export class SystemAudioUnavailableError extends Error {
  constructor() {
    super(SYSTEM_AUDIO_UNAVAILABLE_MESSAGE)
    this.name = 'SystemAudioUnavailableError'
  }
}

export type CaptureSession = {
  /** The stream handed to MediaRecorder. */
  stream: MediaStream
  /** Individual inputs, used for level metering. */
  mic?: MediaStream
  system?: MediaStream
  /** Mixing context (mixed mode only), also usable for metering. */
  context?: AudioContext
  /** Stops every track and closes the mixing context. Safe to call more than once. */
  close: () => void
}

const MIX_SAMPLE_RATE = 16_000

/** Opens the system audio loopback. The unavoidable video track is stopped and removed at once. */
export async function openSystemAudioStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new SystemAudioUnavailableError()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch {
    throw new SystemAudioUnavailableError()
  }
  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop())
    throw new SystemAudioUnavailableError()
  }
  return stream
}

function stopAll(...streams: Array<MediaStream | undefined>) {
  for (const stream of streams) stream?.getTracks().forEach((track) => track.stop())
}

export async function openCapture(source: RecordingSource): Promise<CaptureSession> {
  if (source === 'microphone') {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
    return { stream: mic, mic, close: () => stopAll(mic) }
  }
  if (source === 'system') {
    const system = await openSystemAudioStream()
    return { stream: system, system, close: () => stopAll(system) }
  }

  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  let system: MediaStream
  try {
    system = await openSystemAudioStream()
  } catch (error) {
    stopAll(mic)
    throw error
  }
  let context: AudioContext | undefined
  try {
    context = new AudioContext({ sampleRate: MIX_SAMPLE_RATE })
    await context.resume()
    const destination = context.createMediaStreamDestination()
    destination.channelCount = 1
    context.createMediaStreamSource(mic).connect(destination)
    context.createMediaStreamSource(system).connect(destination)
    const mixContext = context
    let closed = false
    return {
      stream: destination.stream,
      mic,
      system,
      context: mixContext,
      close: () => {
        stopAll(mic, system, destination.stream)
        if (closed) return
        closed = true
        void mixContext.close().catch(() => undefined)
      },
    }
  } catch (error) {
    stopAll(mic, system)
    void context?.close().catch(() => undefined)
    throw error
  }
}
