// Saved recordings own speaker names; explicit transcript drafts export them as note variables
// such as `speaker1:: Alex` under `## Speakers`, referenced as `{{speaker1}}` in the transcript.

const SPEAKERS_HEADING = /^##\s+speakers\s*$/i
const DEFINITION = /^speaker(\d{1,3})\s*::\s*(.*)$/i

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
