import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  assignSpeakers, buildTranscript, buildTranscriptResult, formatTimestamp, formatTranscript,
  mergeSpeakerTurns, normalizeSegments, normalizeSpeakerSegments,
} from '../server/transcription/segments.js'
import { stripTranscriptMarkup } from '../server/knowledge/transcript-markup.js'
import { DIARIZATION_MODELS } from '../server/transcription/models.js'

test('timestamps use mm:ss and switch to h:mm:ss after an hour', () => {
  assert.equal(formatTimestamp(0), '00:00')
  assert.equal(formatTimestamp(83.9), '01:23')
  assert.equal(formatTimestamp(3599), '59:59')
  assert.equal(formatTimestamp(3600), '1:00:00')
  assert.equal(formatTimestamp(3723), '1:02:03')
  assert.equal(formatTimestamp(-4), '00:00')
  assert.equal(formatTimestamp(Number.NaN), '00:00')
})

test('segment normalization drops invalid entries and sorts by start time', () => {
  assert.deepEqual(normalizeSegments([
    { start: 5, end: 7, text: ' later  one ' },
    { start: 1, end: 0.5, text: 'inverted end' },
    { start: 'x', end: 2, text: 'bad start' },
    { start: 2, end: 3, text: '   ' },
    null,
    { start: 0, end: 1, text: 'first' },
  ]), [
    { start: 0, end: 1, text: 'first' },
    { start: 1, end: 1, text: 'inverted end' },
    { start: 5, end: 7, text: 'later one' },
  ])
  assert.deepEqual(normalizeSegments(undefined), [])
  assert.deepEqual(normalizeSpeakerSegments([
    { start: 0, end: 2, speaker: 1 }, { start: 3, end: 3, speaker: 0 }, { start: 1, end: 2, speaker: -1 }, { start: 0, end: 1, speaker: 1.5 },
  ]), [{ start: 0, end: 2, speaker: 1 }])
})

test('each segment takes the speaker with the greatest overlap and speakers are numbered by first appearance', () => {
  const segments = [
    { start: 0, end: 4, text: 'Hello everyone.' },
    { start: 4, end: 9, text: 'Thanks for coming, shall we start?' },
    { start: 9, end: 12, text: 'Yes.' },
  ]
  const turns = [
    { start: 0, end: 3.5, speaker: 3 },
    { start: 3.5, end: 12, speaker: 0 },
  ]
  // The second segment overlaps speaker 3 for 0.5 s and speaker 0 for 4.5 s.
  assert.deepEqual(assignSpeakers(segments, turns).map((segment) => segment.speaker), [1, 2, 2])
})

test('overlap is summed across a speaker\'s turns and ties resolve to the lower speaker slot', () => {
  const segment = [{ start: 0, end: 10, text: 'long' }]
  assert.equal(assignSpeakers(segment, [
    { start: 0, end: 3, speaker: 1 }, { start: 3, end: 6, speaker: 2 }, { start: 6, end: 9, speaker: 1 },
  ])[0].speaker, 1)
  assert.equal(assignSpeakers(segment, [
    { start: 0, end: 5, speaker: 2 }, { start: 5, end: 10, speaker: 1 },
  ])[0].speaker, 1)
})

test('segments no turn covers use a nearby turn, then their neighbours, and never invent a speaker', () => {
  const segments = [
    { start: 0, end: 2, text: 'covered' },
    { start: 3, end: 4, text: 'near the first turn' },
    { start: 20, end: 21, text: 'far away' },
    { start: 30, end: 32, text: 'second speaker' },
  ]
  const turns = [{ start: 0, end: 2.5, speaker: 0 }, { start: 30, end: 33, speaker: 1 }]
  assert.deepEqual(assignSpeakers(segments, turns).map((segment) => segment.speaker), [1, 1, 1, 2])
  assert.deepEqual(assignSpeakers(segments, []).map((segment) => segment.speaker), [null, null, null, null])
  assert.deepEqual(assignSpeakers([], turns), [])
})

test('consecutive segments from the same speaker merge into one turn', () => {
  const turns = mergeSpeakerTurns([
    { start: 0, end: 2, text: 'One.', speaker: 1 },
    { start: 2, end: 4, text: 'Two.', speaker: 1 },
    { start: 4, end: 5, text: 'Three.', speaker: 2 },
    { start: 5, end: 6, text: 'Four.', speaker: 1 },
  ])
  assert.deepEqual(turns.map(({ parts: _parts, ...turn }) => turn), [
    { speaker: 1, start: 0, end: 4, text: 'One. Two.' },
    { speaker: 2, start: 4, end: 5, text: 'Three.' },
    { speaker: 1, start: 5, end: 6, text: 'Four.' },
  ])
})

test('transcripts without speakers are paragraphs prefixed with a timestamp', () => {
  const segments = [
    { start: 83, end: 86, text: 'First sentence.' },
    { start: 86, end: 90, text: 'Second sentence.' },
    { start: 100, end: 104, text: 'After a pause.' },
    { start: 3723, end: 3725, text: 'Much later.' },
  ]
  assert.equal(formatTranscript(segments), [
    '[01:23] First sentence. Second sentence.',
    '[01:40] After a pause.',
    '[1:02:03] Much later.',
  ].join('\n\n'))
  assert.equal(formatTranscript(segments, { speakers: true }), formatTranscript(segments))
})

test('long unbroken speech is split into several paragraphs', () => {
  const sentence = 'This is a reasonably long sentence about the quarterly plan and its owners.'
  const segments = Array.from({ length: 12 }, (_, index) => ({ start: index * 5, end: index * 5 + 4.5, text: sentence }))
  const paragraphs = formatTranscript(segments).split('\n\n')
  assert.ok(paragraphs.length > 1)
  assert.ok(paragraphs.every((paragraph) => /^\[\d{2}:\d{2}\] /.test(paragraph)))
  assert.match(paragraphs[0], /^\[00:00\] /)
})

test('transcripts with speakers show a bold label and timestamp before each turn', () => {
  const built = buildTranscript([
    { start: 0, end: 4, text: 'Hello everyone.' },
    { start: 4, end: 8, text: 'Welcome to the review.' },
    { start: 9, end: 12, text: 'Thanks.' },
  ], [
    { start: 0, end: 8.5, speaker: 2 },
    { start: 8.5, end: 12, speaker: 0 },
  ])
  assert.equal(built.speakerCount, 2)
  assert.equal(built.transcript, [
    '**Speaker 1** [00:00]\nHello everyone. Welcome to the review.',
    '**Speaker 2** [00:09]\nThanks.',
  ].join('\n\n'))
})

test('a transcript result keeps plain text when no segments exist and carries segments otherwise', () => {
  assert.deepEqual(buildTranscriptResult(' Plain text. ', []), { transcript: 'Plain text.', segments: [], speakers: false, speakerCount: 0 })
  const segments = [{ start: 1, end: 2, text: 'Hi.' }]
  const timed = buildTranscriptResult('Hi.', segments)
  assert.equal(timed.transcript, '[00:01] Hi.')
  assert.equal(timed.plainText, 'Hi.')
  assert.equal(timed.speakers, false)
  const spoken = buildTranscriptResult('Hi.', segments, [{ start: 0, end: 3, speaker: 0 }])
  assert.equal(spoken.transcript, '**Speaker 1** [00:01]\nHi.')
  assert.equal(spoken.speakers, true)
  assert.equal(spoken.segments[0].speaker, 1)
  // Speaker turns that never overlap anything leave a timestamp-only transcript.
  assert.equal(buildTranscriptResult('Hi.', segments, []).speakers, false)
})

test('semantic indexing sees spoken text without timestamps or speaker headers', () => {
  const transcript = '**Speaker 1** [00:00]\nHello everyone.\n\n[00:20] More from the same turn.\n\n**Speaker 2** [1:02:03]\nThanks.'
  assert.equal(stripTranscriptMarkup(transcript), 'Hello everyone.\n\nMore from the same turn.\n\nThanks.')
  assert.equal(stripTranscriptMarkup('Meet at [12:30] sharp.\n[draft] keep this'), 'Meet at [12:30] sharp.\n[draft] keep this')
  assert.equal(stripTranscriptMarkup('No markup here.'), 'No markup here.')
  const plain = '[00:05] Only a timestamp.'
  assert.equal(stripTranscriptMarkup(plain), 'Only a timestamp.')
})

test('semantic indexing also strips markup from CRLF notes', () => {
  assert.equal(stripTranscriptMarkup('**Speaker 1** [1:02:03]\r\nHello there.\r\n\r\n[00:09] Bye.'), 'Hello there.\r\n\r\nBye.')
})

test('the Sortformer revision is pinned to a real commit, in sync with the helper', async () => {
  const model = DIARIZATION_MODELS.sortformer
  assert.equal(model.purpose, 'diarization')
  assert.equal(model.repository, 'mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16')
  assert.match(model.revision, /^[0-9a-f]{40}$/)
  assert.deepEqual(model.requiredFiles, ['config.json', 'model.safetensors'])
  const swift = await fs.readFile(new URL('../experiments/mlx-swift/Sources/folio-mlx/main.swift', import.meta.url), 'utf8')
  assert.ok(swift.includes(`modelID: "${model.repository}"`))
  assert.ok(swift.includes(`"${model.revision}"`))
})
