import type { TranscriptionResult, TranscriptionSegment } from './types.ts'

const PAUSE_SECONDS = 4
const MAX_PARAGRAPH_CHARACTERS = 480

function paragraphsOf(segments: readonly TranscriptionSegment[]) {
  const paragraphs: { text: string; end: number }[] = []
  for (const segment of segments) {
    const text = segment.text.trim()
    if (!text) continue
    const current = paragraphs.at(-1)
    if (!current || current.text.length >= MAX_PARAGRAPH_CHARACTERS || segment.start - current.end >= PAUSE_SECONDS) {
      paragraphs.push({ text, end: segment.end })
    } else {
      current.text = `${current.text} ${text}`
      current.end = Math.max(current.end, segment.end)
    }
  }
  return paragraphs.map((paragraph) => paragraph.text)
}

/** Removes `**{{speakerN}}** [mm:ss]` headings and `[mm:ss]` markers from a stored Markdown transcript. */
function stripTranscriptMarkup(transcript: string) {
  return transcript
    .replace(/^\*\*\{\{speaker\d+\}\}\*\*(?:[ \t]*\[(?:\d+:)?\d{1,2}:\d{2}\])?[ \t]*\n?/gm, '')
    .replace(/^\[(?:\d+:)?\d{1,2}:\d{2}\][ \t]*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A copy of the result whose transcript has no speaker headings or timestamps, for a draft without speaker labels. */
export function plainTranscriptResult(result: TranscriptionResult): TranscriptionResult {
  const fromSegments = paragraphsOf(result.segments ?? []).join('\n\n')
  const transcript = fromSegments || result.plainText?.trim() || stripTranscriptMarkup(result.transcript)
  return { ...result, transcript, speakers: false, speakerCount: 0, speakerNumbers: [] }
}
