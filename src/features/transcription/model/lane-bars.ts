// Pure helpers that turn speaker turns into the bars drawn on the lanes, sized for multi-hour recordings.

import type { Turn } from './playback-turns.ts'

export type LaneBar = { start: number; end: number }

/** Bars closer together than this fraction of the recording are drawn as one. */
export const BAR_MERGE_FRACTION = 0.0015

/** Per-speaker bars with near-adjacent turns coalesced, so a 4 hour recording stays at a few hundred elements per lane. */
export function laneBars(turns: readonly Turn[], speakers: readonly number[], duration: number): Map<number, LaneBar[]> {
  const gap = duration > 0 ? duration * BAR_MERGE_FRACTION : 0
  const bars = new Map<number, LaneBar[]>(speakers.map((speaker) => [speaker, []]))
  for (const turn of turns) {
    if (turn.speaker === null) continue
    const lane = bars.get(turn.speaker)
    if (!lane) continue
    const last = lane[lane.length - 1]
    if (last && turn.start - last.end <= gap) last.end = Math.max(last.end, turn.end)
    else lane.push({ start: turn.start, end: Math.max(turn.start, turn.end) })
  }
  return bars
}

/** Percentage offsets of a bar; CSS supplies the minimum visible width. */
export function barPercent(bar: LaneBar, duration: number) {
  if (!(duration > 0)) return { left: 0, width: 0 }
  const left = Math.min(100, Math.max(0, (bar.start / duration) * 100))
  return { left, width: Math.min(100 - left, Math.max(0, ((bar.end - bar.start) / duration) * 100)) }
}

export const SEEK_STEP = 5
export const SEEK_STEP_LARGE = 30

/** Target time for a lane key press, or null when the key is not a seek key. */
export function keyboardSeekTarget(key: string, shift: boolean, time: number, duration: number): number | null {
  const step = shift ? SEEK_STEP_LARGE : SEEK_STEP
  let target: number
  if (key === 'ArrowLeft') target = time - step
  else if (key === 'ArrowRight') target = time + step
  else if (key === 'Home') target = 0
  else if (key === 'End') target = duration
  else return null
  return Math.min(Math.max(0, duration), Math.max(0, target))
}
