export type SentenceWord = { text: string; offset: number }

/** Words of a segment with the character offset where each starts, measured on the exact stored string. */
export function sentenceWords(text: string): SentenceWord[] {
  return Array.from(text.matchAll(/\S+/g), (match) => ({ text: match[0], offset: match.index ?? 0 }))
}

/**
 * The word index whose start is nearest the playhead (the boundary a split would use), estimated
 * proportionally by characters. Null when the playhead is outside the segment or there is nothing to split.
 */
export function nearestBoundary(words: readonly SentenceWord[], length: number, start: number, end: number, time: number): number | null {
  if (words.length < 2 || !(end > start) || time < start || time > end) return null
  const position = length * (time - start) / (end - start)
  let best = 1
  for (let index = 2; index < words.length; index += 1) {
    if (Math.abs(words[index].offset - position) < Math.abs(words[best].offset - position)) best = index
  }
  return best
}
