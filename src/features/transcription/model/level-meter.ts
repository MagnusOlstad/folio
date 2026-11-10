/** Samples below this RMS (about -54 dB) count as silence. */
export const SILENCE_RMS = 0.002
export const SILENCE_WARNING_MS = 8_000

export type SilenceState = { silentSince: number | null; silent: boolean }

export const INITIAL_SILENCE: SilenceState = { silentSince: null, silent: false }

export function rmsOf(samples: ArrayLike<number>): number {
  if (!samples.length) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) sum += (samples[index] ?? 0) ** 2
  return Math.sqrt(sum / samples.length)
}

/** Flags a source once it has stayed below the silence threshold for `SILENCE_WARNING_MS`. */
export function nextSilence(state: SilenceState, rms: number, now: number): SilenceState {
  if (rms >= SILENCE_RMS) return INITIAL_SILENCE
  const silentSince = state.silentSince ?? now
  return { silentSince, silent: now - silentSince >= SILENCE_WARNING_MS }
}

/** Display level 0..1 in steps of 0.1, so meter state changes rarely. */
export function meterLevel(rms: number): number {
  return Math.round(Math.min(1, Math.sqrt(rms) * 1.6) * 10) / 10
}
