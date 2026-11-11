import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  assignSpeakers, buildTranscript, buildTranscriptResult, formatTimestamp, formatTranscript,
  mergeSpeakerTurns, normalizeSegments, normalizeSpeakerSegments, reassignSegmentSpeaker, renameRecordingSpeaker, splitSegment, mergeSegmentWithPrevious, mergeRecordingSpeakers,
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
    '**{{speaker1}}** [00:00]\nHello everyone. Welcome to the review.',
    '**{{speaker2}}** [00:09]\nThanks.',
  ].join('\n\n'))
})

test('a transcript result keeps plain text when no segments exist and carries segments otherwise', () => {
  assert.deepEqual(buildTranscriptResult(' Plain text. ', []), { transcript: 'Plain text.', segments: [], speakers: false, speakerCount: 0, speakerNumbers: [] })
  const segments = [{ start: 1, end: 2, text: 'Hi.' }]
  const timed = buildTranscriptResult('Hi.', segments)
  assert.equal(timed.transcript, '[00:01] Hi.')
  assert.equal(timed.plainText, 'Hi.')
  assert.equal(timed.speakers, false)
  const spoken = buildTranscriptResult('Hi.', segments, [{ start: 0, end: 3, speaker: 0 }])
  assert.equal(spoken.transcript, '**{{speaker1}}** [00:01]\nHi.')
  assert.equal(spoken.speakers, true)
  assert.deepEqual(spoken.speakerNumbers, [1])
  assert.equal(spoken.segments[0].speaker, 1)
  // Speaker turns that never overlap anything leave a timestamp-only transcript.
  assert.equal(buildTranscriptResult('Hi.', segments, []).speakers, false)
})

test('semantic indexing sees spoken text without timestamps or speaker headers', () => {
  const transcript = '**Speaker 1** [00:00]\nHello everyone.\n\n[00:20] More from the same turn.\n\n**Speaker 2** [1:02:03]\nThanks.'
  assert.equal(stripTranscriptMarkup(transcript), 'Hello everyone.\n\nMore from the same turn.\n\nThanks.')
  assert.equal(stripTranscriptMarkup('**Kari** [00:04]\nHei.\n\n**Speaker 2** [00:09]\nHi.\n\n**{{speaker3}}** [00:12]\nYo.\n\n**Kari** [00:20]\n\n**Ola** [00:30]'), 'Kari: Hei.\n\nHi.\n\nYo.\n\n\n')
  assert.equal(stripTranscriptMarkup('Meet at [12:30] sharp.\n[draft] keep this'), 'Meet at [12:30] sharp.\n[draft] keep this')
  assert.equal(stripTranscriptMarkup('No markup here.'), 'No markup here.')
  const plain = '[00:05] Only a timestamp.'
  assert.equal(stripTranscriptMarkup(plain), 'Only a timestamp.')
})

test('semantic indexing also strips markup from CRLF notes', () => {
  assert.equal(stripTranscriptMarkup('**Speaker 1** [1:02:03]\r\nHello there.\r\n\r\n[00:09] Bye.'), 'Hello there.\r\n\r\nBye.')
  assert.equal(stripTranscriptMarkup('**Kari** [1:02:03]\r\nHei.\r\n\r\n[00:09] Bye.'), 'Kari: Hei.\r\n\r\nBye.')
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

test('reassigning a segment speaker rebuilds derived fields without renumbering', () => {
  const segments = [
    { start: 0, end: 2, text: 'One.', speaker: 1 },
    { start: 2, end: 4, text: 'Two.', speaker: 1 },
    { start: 4, end: 6, text: 'Three.', speaker: 2 },
  ]
  const result = { ...buildTranscriptResult('One. Two. Three.', segments), summary: 'kept', plainText: 'kept text' }
  const updated = reassignSegmentSpeaker({ ...result, segments, transcript: 'x', speakerNumbers: [1, 2], speakerCount: 2 }, 1, 3)
  assert.deepEqual(updated.segments.map((segment) => segment.speaker), [1, 3, 2])
  assert.deepEqual(updated.segments[0], segments[0])
  assert.deepEqual(updated.speakerNumbers, [1, 2, 3])
  assert.equal(updated.speakerCount, 3)
  assert.equal(updated.summary, 'kept')
  assert.equal(updated.plainText, 'kept text')
  assert.equal(updated.transcript, formatTranscript(updated.segments, { speakers: true }))
  assert.equal(segments[1].speaker, 1)
  // Moving the only segment of speaker 2 leaves speaker numbers 1 and 3 (no renumbering).
  const gap = reassignSegmentSpeaker(updated, 2, 3)
  assert.deepEqual(gap.speakerNumbers, [1, 3])
  assert.equal(gap.transcript.match(/\*\*\{\{speaker3\}\}\*\*/g).length, 1)
  assert.match(gap.transcript, /\{\{speaker3\}\}\*\* \[00:02\]\nTwo\. Three\./)
})

test('reassigning a segment speaker rejects bad input', () => {
  const segments = [{ start: 0, end: 1, text: 'A', speaker: 1 }, { start: 1, end: 2, text: 'B', speaker: 2 }]
  const result = { segments, transcript: '', speakers: true, speakerCount: 2, speakerNumbers: [1, 2] }
  for (const [index, speaker] of [[-1, 1], [2, 1], [0.5, 1], ['0', 1], [0, 0], [0, 5], [0, 1.5], [0, '2']]) {
    assert.throws(() => reassignSegmentSpeaker(result, index, speaker), { status: 400 })
  }
  assert.throws(() => reassignSegmentSpeaker({ segments: [{ start: 0, end: 1, text: 'A', speaker: null }] }, 0, 1), { status: 400 })
  assert.throws(() => reassignSegmentSpeaker({ segments: [] }, 0, 1), { status: 400 })
})

test('recording speaker names validate the existing ID and normalize blank, multiline, and long names', () => {
  const result = { segments: [{ start: 0, end: 1, text: 'A', speaker: 1 }], speakerNames: { '1': 'Old' }, summary: 'kept' }
  assert.deepEqual(renameRecordingSpeaker(result, 1, '  Kai\n Olsen '), { ...result, speakerNames: { '1': 'Kai Olsen' } })
  assert.deepEqual(renameRecordingSpeaker(result, 1, '  '), { ...result, speakerNames: { '1': 'Speaker 1' } })
  assert.equal(renameRecordingSpeaker(result, 1, 'x'.repeat(70)).speakerNames['1'], 'x'.repeat(64))
  for (const [speaker, name] of [[0, 'A'], [5, 'A'], [1.5, 'A'], [2, 'A'], [1, null], ['1', 'A']]) {
    assert.throws(() => renameRecordingSpeaker(result, speaker, name), { status: 400 })
  }
})

test('merging recording speakers preserves segment fields and identity numbers', () => {
  const result = { ...splitFixture(), segments: [
    { start: 0, end: 1, text: 'A', speaker: 1, extra: { keep: true } },
    { start: 1, end: 2, text: 'B', speaker: 2, custom: 'preserve' },
    { start: 2, end: 3, text: 'C', speaker: 3 },
  ] }
  const merged = mergeRecordingSpeakers(result, 2, 1)
  assert.deepEqual(merged.segments, [
    result.segments[0], { ...result.segments[1], speaker: 1 }, result.segments[2],
  ])
  assert.deepEqual(merged.speakerNumbers, [1, 3])
  assert.equal(merged.speakerCount, 2)
  assert.equal(merged.summary, result.summary)
  assert.equal(merged.transcript, formatTranscript(merged.segments, { speakers: true }))
  const named = { ...result, speakerNames: { '1': 'Speaker 1', '2': 'Sam', '3': 'Taylor' } }
  assert.deepEqual(mergeRecordingSpeakers(named, 2, 1).speakerNames, { '1': 'Sam', '3': 'Taylor' })
  assert.deepEqual(mergeRecordingSpeakers({ ...named, speakerNames: { '1': 'Alex', '2': 'Sam', '3': 'Taylor' } }, 2, 1).speakerNames, { '1': 'Alex', '3': 'Taylor' })
  for (const [source, target] of [[1, 1], [0, 2], [2, 5], [4, 1], [3, 4]]) {
    assert.throws(() => mergeRecordingSpeakers(result, source, target), { status: 400 })
  }
})

function splitFixture() {
  const segments = [
    { start: 0, end: 2, text: 'Intro.', speaker: 1, extra: 'keep' },
    { start: 2, end: 6, text: 'Alpha beta gamma delta', speaker: 1 },
    { start: 6, end: 8, text: 'Outro.', speaker: 2 },
  ]
  return { summary: 'kept', plainText: 'plain', segments, transcript: '', speakers: true, speakerCount: 2, speakerNumbers: [1, 2] }
}

test('splitting a segment estimates the time by characters and preserves fields', () => {
  const result = splitFixture()
  const updated = splitSegment(result, 1, 11, 3)
  assert.equal(updated.segments.length, 4)
  assert.deepEqual(updated.segments[1], { start: 2, end: Math.round((2 + 4 * 10 / 21) * 1000) / 1000, text: 'Alpha beta', speaker: 1 })
  assert.equal(updated.segments[2].start, updated.segments[1].end)
  assert.equal(updated.segments[2].end, 6)
  assert.equal(updated.segments[2].text, 'gamma delta')
  assert.equal(updated.segments[2].speaker, 3)
  assert.deepEqual(updated.speakerNumbers, [1, 2, 3])
  assert.equal(updated.summary, 'kept')
  assert.equal(updated.plainText, 'plain')
  assert.equal(updated.transcript, formatTranscript(updated.segments, { speakers: true }))
  assert.deepEqual(updated.segments[0], result.segments[0])
  assert.equal(result.segments.length, 3)
  // Omitted or null speaker keeps the same speaker; offset on the space itself also works.
  assert.equal(splitSegment(result, 1, 5, undefined).segments[2].speaker, 1)
  assert.equal(splitSegment(result, 1, 5, null).segments[2].text, 'beta gamma delta')
  const fields = splitSegment({ ...result, segments: [{ ...result.segments[0], text: 'Intro. Done' }] }, 0, 7, 1)
  assert.equal(fields.segments[1].extra, 'keep')
})

test('splitting rejects non-boundaries, empty halves and bad speakers', () => {
  const result = splitFixture()
  for (const offset of [0, 3, 22, 40, -1, 1.5, '5', undefined]) assert.throws(() => splitSegment(result, 1, offset, 2), { status: 400 })
  assert.throws(() => splitSegment({ ...result, segments: [{ start: 0, end: 1, text: ' a ', speaker: 1 }] }, 0, 1, 2), { status: 400 })
  for (const speaker of [0, 5, 1.5, '2']) assert.throws(() => splitSegment(result, 1, 5, speaker), { status: 400 })
  assert.throws(() => splitSegment(result, 1, 5, 3, { maxSpeakers: 2 }), { status: 400 })
  for (const index of [-1, 3, 0.5]) assert.throws(() => splitSegment(result, index, 5, 2), { status: 400 })
  assert.throws(() => splitSegment({ segments: [{ start: 0, end: 1, text: 'a b', speaker: null }] }, 0, 1, 1), { status: 400 })
})

test('merging with the previous segment keeps its speaker and undoes a split', () => {
  const result = { ...splitFixture(), speakerNames: { '1': 'Alex', '2': 'Sam' } }
  const split = splitSegment(result, 1, 11, 2)
  const merged = mergeSegmentWithPrevious(split, 2)
  assert.deepEqual(merged.segments, result.segments)
  assert.deepEqual(merged.speakerNames, result.speakerNames)
  assert.deepEqual(merged.speakerNumbers, [1, 2])
  assert.equal(merged.transcript, formatTranscript(result.segments, { speakers: true }))
  const across = mergeSegmentWithPrevious(result, 2)
  assert.deepEqual(across.segments[1], { start: 2, end: 8, text: 'Alpha beta gamma delta Outro.', speaker: 1 })
  assert.throws(() => mergeSegmentWithPrevious(result, 0), { status: 400 })
  assert.throws(() => mergeSegmentWithPrevious(result, 3), { status: 400 })
  assert.throws(() => mergeSegmentWithPrevious({ segments: [] }, 1), { status: 400 })
})

test('segment speaker names survive merging away the last occurrence and splitting it back', () => {
  const result = {
    speakerNames: { '1': 'Alex', '2': 'Sam' },
    segments: [
      { start: 0, end: 2, text: 'Alpha beta', speaker: 1 },
      { start: 2, end: 4, text: 'Gamma delta', speaker: 2 },
    ],
  }
  const merged = mergeSegmentWithPrevious(result, 1)
  assert.deepEqual(merged.speakerNumbers, [1])
  assert.deepEqual(merged.speakerNames, result.speakerNames)
  const restored = splitSegment(merged, 0, 11, 2)
  assert.deepEqual(restored.speakerNumbers, [1, 2])
  assert.deepEqual(restored.speakerNames, result.speakerNames)
  assert.equal(restored.segments[1].speaker, 2)
})
