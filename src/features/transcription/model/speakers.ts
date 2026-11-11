// Saved recordings own speaker names; explicit transcript drafts export them as note variables
// such as `speaker1:: Alex` under `## Speakers`, referenced as `{{speaker1}}` in the transcript.

const SPEAKERS_HEADING = /^##\s+speakers\s*$/i
const DEFINITION = /^speaker(\d{1,3})\s*::\s*(.*)$/i
const REFERENCE = /\{\{\s*speaker(\d{1,3})\s*\}\}/gi

type SpeakerSource = {
  speakers?: boolean | number[]
  speakerNumbers?: number[]
  speakerCount?: number
  segments?: { speaker?: number | null }[]
}

/** Ordered speaker numbers a result contains; older results are derived from segments or the count. */
export function resultSpeakerNumbers(result: SpeakerSource): number[] {
  const listed = [result.speakerNumbers, result.speakers].find(Array.isArray)
  const numbers = listed ?? (result.segments ?? []).map((segment) => segment.speaker)
  const unique = [...new Set(numbers.filter((value): value is number => Number.isInteger(value) && (value as number) > 0))]
  if (unique.length) return unique.sort((left, right) => left - right)
  if (result.speakers === true && Number.isInteger(result.speakerCount) && (result.speakerCount ?? 0) > 0) {
    return Array.from({ length: result.speakerCount as number }, (_, index) => index + 1)
  }
  return []
}

export function speakerDefinitionLine(number: number, name?: string) {
  return `speaker${number}:: ${name || `Speaker ${number}`}`
}

/** Names saved on the transcription result, independent of any linked note draft. */
export function resultSpeakerNames(result: { speakerNames?: Record<string, string> } | null): Map<number, string> {
  if (!result?.speakerNames || typeof result.speakerNames !== 'object') return new Map()
  return new Map(Object.entries(result.speakerNames)
    .map(([number, name]) => [Number(number), name] as const)
    .filter(([number, name]) => Number.isInteger(number) && number > 0 && typeof name === 'string' && Boolean(name.trim())))
}

function sectionBounds(lines: string[]) {
  const start = lines.findIndex((line) => SPEAKERS_HEADING.test(line.trim()))
  if (start < 0) return null
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  return { start, end: next < 0 ? lines.length : next }
}

/** `speakerN:: name` definitions in the `## Speakers` section only; the first definition of a number wins. */
export function parseSpeakerNames(markdown: string): Map<number, string> {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const bounds = sectionBounds(lines)
  const names = new Map<number, string>()
  if (!bounds) return names
  for (const line of lines.slice(bounds.start + 1, bounds.end)) {
    const match = DEFINITION.exec(line.trim())
    const name = match?.[2].trim()
    if (match && name && !names.has(Number(match[1]))) names.set(Number(match[1]), name)
  }
  return names
}

/** Replaces `{{speakerN}}` with the defined name, or "Speaker N" when the draft defines none. */
export function resolveSpeakerNames(transcript: string, names: Map<number, string>) {
  return transcript.replace(REFERENCE, (_match, digits: string) => names.get(Number(digits)) ?? `Speaker ${Number(digits)}`)
}

/**
 * Makes sure every number has a definition line in the `## Speakers` section. Existing lines are never
 * edited or removed; the section is created before `## Transcript` (or at the end) when it is missing.
 */
export function reconcileSpeakersSection(markdown: string, numbers: number[]) {
  if (!numbers.length) return markdown
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const bounds = sectionBounds(lines)
  const defined = new Set<number>()
  if (bounds) {
    for (const line of lines.slice(bounds.start + 1, bounds.end)) {
      const match = DEFINITION.exec(line.trim())
      if (match) defined.add(Number(match[1]))
    }
  }
  const additions = numbers.filter((number) => !defined.has(number)).map((number) => speakerDefinitionLine(number))
  if (bounds) {
    if (!additions.length) return markdown
    const body = lines.slice(bounds.start + 1, bounds.end)
    while (body.length && body[body.length - 1].trim() === '') body.pop()
    const section = [...(body.length ? body : ['']), ...additions, '']
    lines.splice(bounds.start + 1, bounds.end - bounds.start - 1, ...section)
    return `${lines.join('\n').trimEnd()}\n`
  }
  const block = ['## Speakers', '', ...additions, '']
  const transcriptAt = lines.findIndex((line) => /^##\s+transcript\s*$/i.test(line.trim()))
  if (transcriptAt < 0) return `${markdown.trimEnd()}\n\n${block.join('\n').trimEnd()}\n`
  lines.splice(transcriptAt, 0, ...block)
  return `${lines.join('\n').trimEnd()}\n`
}

export const MAX_SPEAKER_NAME_LENGTH = 64

/** Single-line, trimmed, at most 64 characters; blank resets to "Speaker N". */
export function normalizeSpeakerName(number: number, name: string) {
  const cleaned = name.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEAKER_NAME_LENGTH).trim()
  return cleaned || `Speaker ${number}`
}

/**
 * Sets `speakerN:: name` in the `## Speakers` section: the first existing definition of that number is
 * rewritten in place, otherwise the line is added to the section (created before `## Transcript`, or at
 * the end, when missing). Every other line is untouched and the document's line endings are kept.
 */
export function setSpeakerName(markdown: string, number: number, name: string) {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const line = `speaker${number}:: ${normalizeSpeakerName(number, name)}`
  const bounds = sectionBounds(lines)
  if (bounds) {
    const existing = lines.findIndex((candidate, index) => index > bounds.start && index < bounds.end
      && Number(DEFINITION.exec(candidate.trim())?.[1]) === number)
    if (existing >= 0) lines[existing] = line
    else {
      let last = bounds.end - 1
      while (last > bounds.start && lines[last].trim() === '') last -= 1
      const insert = last === bounds.start ? ['', line] : [line]
      lines.splice(last + 1, 0, ...insert)
      const after = last + 1 + insert.length
      if (after < lines.length && lines[after].trim() !== '') lines.splice(after, 0, '')
    }
    return lines.join(eol)
  }
  const block = ['## Speakers', '', line, '']
  const transcriptAt = lines.findIndex((candidate) => /^##\s+transcript\s*$/i.test(candidate.trim()))
  if (transcriptAt >= 0) lines.splice(transcriptAt, 0, ...block)
  else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push('', ...block)
  }
  return lines.join(eol)
}

/** Retargets note variable references to the surviving identity and removes the absorbed definition. */
