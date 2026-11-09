import { useState } from 'react'
import type { ReassignOutcome } from '../hooks/speakerReassign.ts'
import { formatClock, reassignOptions, speakerColor, speakerDisplayName } from '../model/playback-turns.ts'
import type { TranscriptionSegment } from '../model/types.ts'
import { RowMenu, type RowMenuItem } from './RowMenu.tsx'

// The rewrite warning is shown before the first reassignment per recording in this app run.
const confirmedSessions = new Set<string>()

type NowSpeakingProps = {
  sessionId: string
  segments: readonly TranscriptionSegment[]
  index: number
  present: readonly number[]
  names: ReadonlyMap<number, string> | null
  hasSpeakers: boolean
  onReassign: (index: number, speaker: number) => Promise<ReassignOutcome>
  onApplied: (outcome: ReassignOutcome) => void
}

/** Previous (muted), current (large) and next (muted) segment with a "Wrong speaker?" correction. */
export function NowSpeaking({ sessionId, segments, index, present, names, hasSpeakers, onReassign, onApplied }: NowSpeakingProps) {
  const [pendingSpeaker, setPendingSpeaker] = useState<number | null>(null)
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const current = segments[index]
  if (!current) return null
  const speaker = current.speaker ?? null

  async function reassign(target: number) {
    setPendingSpeaker(null)
    setWorking(true)
    setError('')
    try {
      const outcome = await onReassign(index, target)
      confirmedSessions.add(sessionId)
      setNote(`Moved to ${speakerDisplayName(target, names)}.${outcome.draftUpdated ? '' : " Draft not open, so only the recording's transcript changed."}`)
      onApplied(outcome)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not change the speaker.')
    } finally { setWorking(false) }
  }

  function choose(target: number) {
    setNote('')
    if (confirmedSessions.has(sessionId)) void reassign(target)
    else setPendingSpeaker(target)
  }

  const moveItems: RowMenuItem[] = reassignOptions(present, speaker).map((option) => ({
    key: String(option),
    label: present.includes(option) ? speakerDisplayName(option, names) : 'New speaker',
    leading: <i className="player-dot" style={{ background: speakerColor(option) }} aria-hidden="true" />,
    onSelect: () => choose(option),
  }))

  return (
    <div className="player-now" aria-label="Now speaking">
      <p className="player-now-neighbour">{segments[index - 1]?.text.trim() || ' '}</p>
      <div className="player-now-head">
        {speaker !== null && <i className="player-dot" style={{ background: speakerColor(speaker) }} aria-hidden="true" />}
        <strong>{speaker !== null ? speakerDisplayName(speaker, names) : 'Speaker unknown'}</strong>
        <time>{formatClock(current.start)}</time>
      </div>
      <p className="player-now-current">{current.text.trim()}</p>
      <p className="player-now-neighbour">{segments[index + 1]?.text.trim() || ' '}</p>
      {hasSpeakers && (
        <div className="player-reassign">
          <RowMenu
            label="Move this sentence to"
            triggerText="Wrong speaker?"
            triggerClassName="player-reassign-trigger"
            disabled={working}
            items={moveItems}
          />
        </div>
      )}
      {pendingSpeaker !== null && (
        <div className="player-reassign-confirm" role="group" aria-label="Confirm speaker change">
          <p>Moving a sentence rebuilds the Transcript section of the draft. Edits you made inside that section will be replaced.</p>
          <button type="button" onClick={() => setPendingSpeaker(null)}>Cancel</button>
          <button type="button" className="transcription-retranscribe-confirm-button" onClick={() => void reassign(pendingSpeaker)}>Move sentence</button>
        </div>
      )}
      {note && <p className="player-note" role="status">{note}</p>}
      {error && <p className="transcription-item-error" role="alert">{error}</p>}
    </div>
  )
}
