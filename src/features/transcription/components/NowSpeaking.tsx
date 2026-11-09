import { useState } from 'react'
import type { ReassignOutcome } from '../hooks/speakerReassign.ts'
import { formatClock, reassignOptions, speakerColor, speakerDisplayName } from '../model/playback-turns.ts'
import type { TranscriptionSegment } from '../model/types.ts'

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

/** Previous (muted), current (large) and next (muted) segment with a "Who said this?" correction. */
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
      setNote(outcome.draftUpdated ? 'Transcript section updated in the draft.' : 'Draft not open — transcript updated in the recording.')
      onApplied(outcome)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not change the speaker.')
    } finally { setWorking(false) }
  }

  function choose(value: string) {
    if (value === 'keep') return
    const target = Number(value)
    setNote('')
    if (confirmedSessions.has(sessionId)) void reassign(target)
    else setPendingSpeaker(target)
  }

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
        <label className="player-reassign">
          <span>Who said this?</span>
          <select aria-label="Who said this?" value="keep" disabled={working} onChange={(event) => choose(event.currentTarget.value)}>
            <option value="keep">Right speaker</option>
            {reassignOptions(present, speaker).map((option) => (
              <option key={option} value={option}>
                {present.includes(option) ? `Was ${speakerDisplayName(option, names)}` : `New speaker ${option}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {pendingSpeaker !== null && (
        <div className="player-reassign-confirm" role="group" aria-label="Confirm speaker change">
          <p>This rewrites the Transcript section of the draft; edits you made inside it will be replaced.</p>
          <button type="button" onClick={() => setPendingSpeaker(null)}>Cancel</button>
          <button type="button" className="transcription-retranscribe-confirm-button" onClick={() => void reassign(pendingSpeaker)}>Reassign</button>
        </div>
      )}
      {note && <p className="player-note" role="status">{note}</p>}
      {error && <p className="transcription-item-error" role="alert">{error}</p>}
    </div>
  )
}
