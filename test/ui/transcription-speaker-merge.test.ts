import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeRecordingSpeakers, reassignSegmentSpeaker, renameRecordingSpeaker } from '../../src/features/transcription/hooks/speakerReassign.ts'
import { resultSpeakerNames } from '../../src/features/transcription/model/speakers.ts'
import { mergeTranscriptionDraft, type TranscriptionResult, type TranscriptionSession } from '../../src/features/transcription/model/types.ts'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('../../src/lib/api.ts', () => ({ apiForBundle: apiMock }))
beforeEach(() => apiMock.mockReset())

const session: TranscriptionSession = { id: 'merge-session', state: 'ready', draftId: null, durationMs: 10_000, error: null, sourceBundleId: 'bundle-a', fileName: 'meeting.wav' }
const result: TranscriptionResult = {
  summary: 'saved summary', speakers: true, speakerCount: 2, speakerNumbers: [1, 2],
  transcript: '**{{speaker1}}** [00:00]\nFirst.\n\n**{{speaker2}}** [00:03]\nSecond.',
  segments: [{ start: 0, end: 1, text: 'First.', speaker: 1 }, { start: 3, end: 4, text: 'Second.', speaker: 2 }],
}

describe('recording-owned speaker data', () => {
  it('formats a fresh draft from saved speaker names', () => {
    const named = { ...result, speakerNames: { '1': 'Saved Alex', '2': 'Saved Sam' } }
    expect(mergeTranscriptionDraft(session, named)).toContain('speaker1:: Saved Alex\nspeaker2:: Saved Sam')
    expect([...resultSpeakerNames(named)]).toEqual([[1, 'Saved Alex'], [2, 'Saved Sam']])
    expect([...resultSpeakerNames(result)]).toEqual([])
  })

  it('persists a rename through the recording API without a draft adapter', async () => {
    const named = { ...result, speakerNames: { '2': 'Ola' } }
    apiMock.mockResolvedValueOnce({ result: named })
    await expect(renameRecordingSpeaker(session, 2, 'Ola')).resolves.toEqual(named)
    expect(apiMock).toHaveBeenCalledWith('bundle-a', '/api/transcriptions/merge-session/speakers/name', {
      method: 'POST', body: JSON.stringify({ speaker: 2, name: 'Ola' }),
    })
  })

  it('sends every other speaker edit only to the recording endpoint', async () => {
    apiMock.mockResolvedValueOnce({ result }).mockResolvedValueOnce({ result })
    await reassignSegmentSpeaker(session, 0, 2)
    await mergeRecordingSpeakers(session, 2, 1)
    expect(apiMock.mock.calls.map(([, path]) => path)).toEqual([
      '/api/transcriptions/merge-session/segments/speaker',
      '/api/transcriptions/merge-session/speakers/merge',
    ])
  })
})
