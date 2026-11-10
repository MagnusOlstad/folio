// Pure helpers behind the recording player: turns, lane geometry, current-segment lookup, solo playback.

import type { TranscriptionSegment } from './types.ts'

export const MAX_SPEAKERS = 4

/** Consecutive segments from the same speaker, merged into one block on a lane. */
export type Turn = { start: number; end: number; speaker: number | null; firstSegment: number; lastSegment: number }

export type SoloStep = { kind: 'inside' } | { kind: 'jump'; to: number } | { kind: 'end' }

const EPSILON = 0.05

export function buildTurns(segments: readonly TranscriptionSegment[]): Turn[] {
  const turns: Turn[] = []
  segments.forEach((segment, index) => {
    const speaker = segment.speaker ?? null
    const last = turns[turns.length - 1]
    if (last && last.speaker === speaker) {
      last.end = Math.max(last.end, segment.end)
      last.lastSegment = index
    } else turns.push({ start: segment.start, end: Math.max(segment.start, segment.end), speaker, firstSegment: index, lastSegment: index })
  })
  return turns
}

/** Index of the segment containing `time`, or of the latest one that started before it; -1 before the first. */
export function findSegmentIndex(segments: readonly { start: number; end: number }[], time: number) {
  let low = 0
  let high = segments.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (segments[mid].start <= time) { found = mid; low = mid + 1 } else high = mid - 1
  }
  return found
}

export function findTurnIndex(turns: readonly Turn[], time: number) {
  return findSegmentIndex(turns, time)
}

export function turnCounts(turns: readonly Turn[]) {
  const counts = new Map<number, number>()
  for (const turn of turns) if (turn.speaker !== null) counts.set(turn.speaker, (counts.get(turn.speaker) ?? 0) + 1)
  return counts
}

/** Speaker numbers present in the segments, ascending. */
export function segmentSpeakers(segments: readonly TranscriptionSegment[]) {
  return [...new Set(segments.map((segment) => segment.speaker).filter((value): value is number => typeof value === 'number'))].sort((a, b) => a - b)
}

export function totalDuration(segments: readonly TranscriptionSegment[], mediaDuration: number, sessionSeconds: number | null) {
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration
  const lastEnd = segments.reduce((max, segment) => Math.max(max, segment.end), 0)
  return Math.max(lastEnd, sessionSeconds ?? 0)
}

/** Percentage offsets of a bar on a lane. Bars keep a visible minimum width. */
export function laneGeometry(turn: Pick<Turn, 'start' | 'end'>, duration: number) {
  if (!(duration > 0)) return { left: 0, width: 0 }
  const left = Math.min(100, Math.max(0, (turn.start / duration) * 100))
  const width = Math.min(100 - left, Math.max(0.6, ((turn.end - turn.start) / duration) * 100))
  return { left, width }
}

export function laneTimeAt(fraction: number, duration: number) {
  return Math.min(duration, Math.max(0, fraction * duration))
}

/** Where solo playback for `speaker` should be when the playhead is at `time`. O(log n) to find the neighbourhood. */
export function soloStep(turns: readonly Turn[], speaker: number, time: number): SoloStep {
  for (let index = Math.max(0, findTurnIndex(turns, time + EPSILON)); index < turns.length; index += 1) {
    const turn = turns[index]
    if (turn.speaker !== speaker) continue
    if (time < turn.start - EPSILON) return { kind: 'jump', to: turn.start }
    if (time < turn.end - EPSILON) return { kind: 'inside' }
  }
  return { kind: 'end' }
}

/** Start of the next (direction 1) or previous (-1) turn, optionally limited to one speaker. */
export function adjacentTurnStart(turns: readonly Turn[], time: number, direction: 1 | -1, speaker: number | null = null) {
  const matches = (turn: Turn) => speaker === null || turn.speaker === speaker
  if (direction === 1) {
    for (let index = findTurnIndex(turns, time + EPSILON) + 1; index < turns.length; index += 1) {
      if (matches(turns[index])) return turns[index].start
    }
    return null
  }
  // A few seconds into a turn, "previous" restarts that turn first, like a media player.
  for (let index = findTurnIndex(turns, time - 1 - Number.EPSILON); index >= 0; index -= 1) {
    if (matches(turns[index]) && turns[index].start < time - 1) return turns[index].start
  }
  return turns.find(matches)?.start ?? null
}

export function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

export function speakerDisplayName(speaker: number, names: ReadonlyMap<number, string> | null | undefined) {
  return names?.get(speaker) || `Speaker ${speaker}`
}

/** Palette slot 1..4 for a speaker number. */
export function speakerColorIndex(speaker: number) {
  return ((Math.max(1, Math.trunc(speaker)) - 1) % MAX_SPEAKERS) + 1
}

export function speakerColor(speaker: number) {
  return `var(--speaker-${speakerColorIndex(speaker)})`
}

/** Speaker numbers a segment can be reassigned to: the others present plus the next free one (up to four). */
export function reassignOptions(present: readonly number[], current: number | null) {
  const options = present.filter((speaker) => speaker !== current)
  if (present.length < MAX_SPEAKERS) {
    for (let speaker = 1; speaker <= MAX_SPEAKERS; speaker += 1) {
      if (!present.includes(speaker)) { options.push(speaker); break }
    }
  }
  return options
}
