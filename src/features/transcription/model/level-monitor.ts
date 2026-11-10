import { INITIAL_SILENCE, meterLevel, nextSilence, rmsOf, type SilenceState } from './level-meter.ts'

export type SourceLevels = { mic: number; system: number }
export type SourceSilence = { mic: boolean; system: boolean }
export type LevelSnapshot = { levels: SourceLevels; silent: SourceSilence }

export const IDLE_SNAPSHOT: LevelSnapshot = { levels: { mic: 0, system: 0 }, silent: { mic: false, system: false } }

const TICK_MS = 100

type Probe = { key: 'mic' | 'system'; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer>; silence: SilenceState }

/**
 * Samples one analyser per source about ten times a second and reports only when a quantised
 * level or a silence flag changes. Metering is best-effort: any failure leaves recording untouched.
 */
export function startLevelMonitor(
  inputs: { mic?: MediaStream; system?: MediaStream },
  onSnapshot: (snapshot: LevelSnapshot) => void,
  sharedContext?: AudioContext,
): () => void {
  let context: AudioContext | undefined = sharedContext
  const ownsContext = !sharedContext
  try {
    context ??= new AudioContext()
    const audioContext = context
    void audioContext.resume?.()?.catch?.(() => undefined)
    const probes: Probe[] = []
    for (const key of ['mic', 'system'] as const) {
      const stream = inputs[key]
      if (!stream) continue
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      audioContext.createMediaStreamSource(stream).connect(analyser)
      probes.push({ key, analyser, samples: new Float32Array(analyser.fftSize), silence: INITIAL_SILENCE })
    }
    let current = IDLE_SNAPSHOT
    const timer = window.setInterval(() => {
      const levels = { ...current.levels }
      const silent = { ...current.silent }
      for (const probe of probes) {
        probe.analyser.getFloatTimeDomainData(probe.samples)
        const rms = rmsOf(probe.samples)
        levels[probe.key] = meterLevel(rms)
        probe.silence = nextSilence(probe.silence, rms, Date.now())
        silent[probe.key] = probe.silence.silent
      }
      const changed = levels.mic !== current.levels.mic || levels.system !== current.levels.system
        || silent.mic !== current.silent.mic || silent.system !== current.silent.system
      if (!changed) return
      current = { levels, silent }
      onSnapshot(current)
    }, TICK_MS)
    return () => {
      window.clearInterval(timer)
      if (ownsContext) void audioContext.close().catch(() => undefined)
    }
  } catch {
    if (ownsContext) void context?.close?.()?.catch?.(() => undefined)
    return () => undefined
  }
}
