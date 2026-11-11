import { describe, expect, it, vi } from 'vitest'
import { mergeRecordingSpeakers } from '../../src/features/transcription/hooks/speakerReassign.ts'
import type { DraftWorkContext } from '../../src/features/transcription/hooks/draftWork.ts'
import type { TranscriptionResult, TranscriptionSession } from '../../src/features/transcription/model/types.ts'

const session: TranscriptionSession = { id: 'merge-session', state: 'ready', draftId: null, durationMs: 10_000, error: null, sourceBundleId: 'bundle-a' }
const result: TranscriptionResult = {
  summary: 'stored summary', speakers: true, speakerCount: 1, speakerNumbers: [1],
  transcript: '**{{speaker1}}** [00:00]\nFirst. Second.',
  segments: [{ start: 0, end: 1, text: 'First.', speaker: 1 }, { start: 1, end: 2, text: 'Second.', speaker: 1 }],
}

function context(content?: string) {
  const updated = vi.fn()
  const getDraftContent = vi.fn(() => content)
  const sessionDrafts = { current: content ? new Map([['merge-session', { draftId: 'untitled:merge', bundleId: 'bundle-a' }]]) : new Map() }
  const ctx = {
    busyRef: { current: false }, deletingRef: { current: null }, activeBundle: { current: 'bundle-a' }, bundleGeneration: { current: 0 },
    sessionDrafts,
    draftsRef: { current: {
      getDraftContent, getDraftDocument: vi.fn(), isDraftOpen: () => true, updateDraftContent: updated,
      createDraft: vi.fn(), openDraft: vi.fn(),
    } },
    setError: vi.fn(), setMessage: vi.fn(), setPhase: vi.fn(), setProgress: vi.fn(), setActiveSession: vi.fn(), refresh: vi.fn(async () => undefined),
  } as DraftWorkContext
  return { ctx, updated }
}

describe('recording speaker merge draft updates', () => {
  it('preserves custom summary and transcript text while remapping source references and removing its definition', async () => {
    const draft = '# Meeting\n\n## Summary\n\nCustom {{speaker2}} summary.\n\n## Speakers\n\nspeaker1:: Alex\nspeaker2:: Sam\n\n## Transcript\n\nCustom edited text at [00:00].\n'
    const { ctx, updated } = context(draft)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200 })))
    const outcome = await mergeRecordingSpeakers(ctx, session, 2, 1)
    expect(outcome).toEqual({ result, draftUpdated: true })
    expect(updated).toHaveBeenCalledWith('untitled:merge', '# Meeting\n\n## Summary\n\nCustom {{speaker1}} summary.\n\n## Speakers\n\nspeaker1:: Alex\n\n## Transcript\n\nCustom edited text at [00:00].\n')
    vi.unstubAllGlobals()
  })

  it('updates the saved result without creating a draft when none is open', async () => {
    const { ctx, updated } = context()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200 })))
    const outcome = await mergeRecordingSpeakers(ctx, session, 2, 1)
    expect(outcome).toEqual({ result, draftUpdated: false })
    expect(updated).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
