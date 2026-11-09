// Timestamps inside the `## Transcript` section of a transcript draft: `[mm:ss]` or `[h:mm:ss]`, at the
// start of a line or right after a `**{{speakerN}}**` turn label.

export type TranscriptTimestamp = {
  /** Offsets of the bracketed text, brackets included. */
  from: number
  to: number
  seconds: number
  /** 0-based line index of the document. */
  line: number
}

const STAMP = /^(?:\*\*[^*\n]*\*\*[ \t]+)?\[(?:(\d{1,3}):)?(\d{1,3}):(\d{2})\]/

export function timestampSeconds(hours: string | undefined, minutes: string, seconds: string) {
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/** Timestamps found at line starts within the Transcript section (or the whole text when there is none). */
export function parseTranscriptTimestamps(text: string): TranscriptTimestamp[] {
  const stamps: TranscriptTimestamp[] = []
  const hasSection = /^##[ \t]+transcript[ \t]*\r?$/im.test(text)
  let inSection = !hasSection
  let offset = 0
  let lineIndex = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (/^##\s/.test(line)) inSection = /^##[ \t]+transcript[ \t]*$/i.test(line)
    else if (inSection) {
      const match = STAMP.exec(line)
      if (match) {
        const bracket = match[0].lastIndexOf('[')
        stamps.push({
          from: offset + bracket,
          to: offset + match[0].length,
          seconds: timestampSeconds(match[1], match[2], match[3]),
          line: lineIndex,
        })
      }
    }
    offset += rawLine.length + 1
    lineIndex += 1
  }
  return stamps
}

/** Index of the last timestamp at or before `seconds`, or -1. Timestamps are in document order. */
export function activeTimestampIndex(stamps: readonly TranscriptTimestamp[], seconds: number) {
  let low = 0
  let high = stamps.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (stamps[mid].seconds <= seconds) { found = mid; low = mid + 1 } else high = mid - 1
  }
  return found
}

/** Inclusive 0-based line range of the turn/paragraph that starts at `stamps[index]`. */
export function timestampBlockLines(stamps: readonly TranscriptTimestamp[], index: number, lineCount: number, text: string) {
  const start = stamps[index].line
  const nextLine = index + 1 < stamps.length ? stamps[index + 1].line : lineCount
  const lines = text.split('\n')
  let end = nextLine - 1
  while (end > start && (lines[end] ?? '').trim() === '') end -= 1
  return { start, end }
}
