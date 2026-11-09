// Pure helpers that turn Whisper segments (and optional Sortformer speaker turns) into the
// Markdown transcript Folio stores. Nothing here touches the filesystem or the MLX helper.

const PARAGRAPH_MAX_CHARACTERS = 480
const PARAGRAPH_PAUSE_SECONDS = 4
const SPEAKER_MAX_GAP_SECONDS = 2

function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Validates helper output; invalid entries are dropped and the result is sorted by start time. */
export function normalizeSegments(raw) {
  if (!Array.isArray(raw)) return []
  const segments = []
  for (const item of raw) {
    const start = finiteTime(item?.start)
    const end = finiteTime(item?.end)
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : ''
    if (start === null || end === null || !text) continue
    segments.push({ start, end: Math.max(start, end), text })
  }
  return segments.map((segment, index) => ({ segment, index }))
    .sort((left, right) => left.segment.start - right.segment.start || left.index - right.index)
    .map(({ segment }) => segment)
}

/** Validates diarization output. `speaker` is the model's speaker slot (0-based integer). */
export function normalizeSpeakerSegments(raw) {
  if (!Array.isArray(raw)) return []
  const turns = []
  for (const item of raw) {
    const start = finiteTime(item?.start)
    const end = finiteTime(item?.end)
    if (start === null || end === null || end <= start || !Number.isInteger(item?.speaker) || item.speaker < 0) continue
    turns.push({ start, end, speaker: item.speaker })
  }
  return turns.sort((left, right) => left.start - right.start)
}

/** `01:23`, or `1:02:03` once the time passes an hour. */
export function formatTimestamp(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${String(minutes).padStart(2, '0')}:${rest}`
}

function distanceBetween(segment, turn) {
  return Math.max(0, turn.start - segment.end, segment.start - turn.end)
}

function dominantSpeaker(segment, turns, maxGap) {
  const overlaps = new Map()
  for (const turn of turns) {
    if (turn.start >= segment.end && segment.end > segment.start) break
    const overlap = Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start)
    if (overlap > 0) overlaps.set(turn.speaker, (overlaps.get(turn.speaker) || 0) + overlap)
  }
  let best = null
  let bestOverlap = 0
  for (const [speaker, overlap] of overlaps) {
    if (overlap > bestOverlap || (overlap === bestOverlap && best !== null && speaker < best)) { best = speaker; bestOverlap = overlap }
  }
  if (best !== null) return best
  // No overlap (or a zero-length segment): use the closest turn when it is close enough.
  let nearest = null
  let nearestDistance = Infinity
  for (const turn of turns) {
    const distance = distanceBetween(segment, turn)
    if (distance < nearestDistance) { nearest = turn.speaker; nearestDistance = distance }
  }
  return nearest !== null && nearestDistance <= maxGap ? nearest : null
}

/**
 * Gives each Whisper segment the speaker with the greatest time overlap. Segments that no turn
 * covers take the nearest turn within `maxGap` seconds, then the previous (or next) segment's
 * speaker. Speakers are renumbered 1, 2, 3… in order of first appearance in the transcript, so
 * "Speaker 1" is whoever speaks first. Returns segments with `speaker` (number) or null.
 */
export function assignSpeakers(segments, speakerSegments, { maxGap = SPEAKER_MAX_GAP_SECONDS } = {}) {
  const turns = normalizeSpeakerSegments(speakerSegments)
  if (!turns.length) return segments.map((segment) => ({ ...segment, speaker: null }))
  const slots = segments.map((segment) => dominantSpeaker(segment, turns, maxGap))
  let carried = null
  for (let index = 0; index < slots.length; index += 1) {
    if (slots[index] === null) slots[index] = carried
    else carried = slots[index]
  }
  carried = null
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (slots[index] === null) slots[index] = carried
    else carried = slots[index]
  }
  const labels = new Map()
  return segments.map((segment, index) => {
    const slot = slots[index]
    if (slot === null) return { ...segment, speaker: null }
    if (!labels.has(slot)) labels.set(slot, labels.size + 1)
    return { ...segment, speaker: labels.get(slot) }
  })
}

/** Merges consecutive segments from the same speaker into one turn. */
export function mergeSpeakerTurns(segments) {
  const turns = []
  for (const segment of segments) {
    const previous = turns.at(-1)
    if (previous && previous.speaker === segment.speaker) {
      previous.end = Math.max(previous.end, segment.end)
      previous.parts.push(segment)
    } else {
      turns.push({ speaker: segment.speaker, start: segment.start, end: segment.end, parts: [segment] })
    }
  }
  return turns.map(({ parts, ...turn }) => ({ ...turn, text: parts.map((part) => part.text).join(' '), parts }))
}

// Groups segments into readable paragraphs, breaking on long runs or long pauses.
function paragraphsOf(segments) {
  const paragraphs = []
  let current = null
  for (const segment of segments) {
    const gap = current ? segment.start - current.end : 0
    if (!current || current.text.length >= PARAGRAPH_MAX_CHARACTERS || gap >= PARAGRAPH_PAUSE_SECONDS) {
      current = { start: segment.start, end: segment.end, text: segment.text }
      paragraphs.push(current)
    } else {
      current.text = `${current.text} ${segment.text}`
      current.end = Math.max(current.end, segment.end)
    }
  }
  return paragraphs
}

/**
 * Renders the transcript Markdown.
 * Without speakers: `[01:23] text` paragraphs.
 * With speakers: `**Speaker 1** [01:23]` followed by the turn's text; a long turn continues in
 * `[01:50] text` paragraphs so no single block grows unbounded.
 */
export function formatTranscript(segments, { speakers = false } = {}) {
  const labelled = speakers && segments.length > 0 && segments.every((segment) => Number.isInteger(segment.speaker))
  if (!labelled) {
    return paragraphsOf(segments).map((paragraph) => `[${formatTimestamp(paragraph.start)}] ${paragraph.text}`).join('\n\n')
  }
  return mergeSpeakerTurns(segments).map((turn) => {
    const [first, ...rest] = paragraphsOf(turn.parts)
    const opening = `**Speaker ${turn.speaker}** [${formatTimestamp(turn.start)}]\n${first.text}`
    return [opening, ...rest.map((paragraph) => `[${formatTimestamp(paragraph.start)}] ${paragraph.text}`)].join('\n\n')
  }).join('\n\n')
}

/**
 * Builds the stored transcript from Whisper segments and optional speaker turns.
 * `speakerCount` is 0 when no speaker labels were applied.
 */
export function buildTranscript(segments, speakerSegments = null) {
  const wantsSpeakers = Array.isArray(speakerSegments) && speakerSegments.length > 0
  const assigned = wantsSpeakers ? assignSpeakers(segments, speakerSegments) : segments
  const speakers = wantsSpeakers && assigned.every((segment) => Number.isInteger(segment.speaker))
  return {
    segments: assigned,
    transcript: formatTranscript(assigned, { speakers }),
    speakerCount: speakers ? new Set(assigned.map((segment) => segment.speaker)).size : 0,
  }
}

/**
 * Result fields for a finished transcription. Without segments (an older helper) the plain text is
 * kept as before; otherwise the transcript carries timestamps and, when turns are supplied, speakers.
 */
export function buildTranscriptResult(text, segments, speakerTurns = null) {
  const plainText = String(text).trim()
  if (!segments.length) return { transcript: plainText, segments: [], speakers: false, speakerCount: 0 }
  const built = buildTranscript(segments, speakerTurns)
  return { transcript: built.transcript, plainText, segments: built.segments, speakers: built.speakerCount > 0, speakerCount: built.speakerCount }
}
