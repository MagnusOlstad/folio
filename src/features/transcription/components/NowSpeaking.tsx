import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReassignOutcome } from '../hooks/speakerReassign.ts'
import { formatClock, reassignOptions, speakerColor, speakerDisplayName } from '../model/playback-turns.ts'
import { nearestBoundary, sentenceWords } from '../model/split-sentence.ts'
import type { TranscriptionSegment } from '../model/types.ts'
import { ChevronIcon, MergeUpIcon, ScissorsIcon } from './icons.tsx'
import { RowMenu, type RowMenuItem } from './RowMenu.tsx'
import { SplitSentence } from './SplitSentence.tsx'

// The rewrite warning is shown before the first speaker edit per recording in this app run.
const confirmedSessions = new Set<string>()

type NowSpeakingProps = {
  sessionId: string
  segments: readonly TranscriptionSegment[]
  index: number
  /** Playback position in seconds, used to preselect the split point. */
  time: number
  present: readonly number[]
  names: ReadonlyMap<number, string> | null
  hasSpeakers: boolean
  onReassign: (index: number, speaker: number) => Promise<ReassignOutcome>
  onSplit: (index: number, offset: number, speaker: number | null) => Promise<ReassignOutcome>
  onMerge: (index: number) => Promise<ReassignOutcome>
  onApplied: (outcome: ReassignOutcome) => void
}

type Pending = { index: number; confirmLabel: string; run: () => Promise<void> }
type Note = { text: string; undo: (() => Promise<ReassignOutcome>) | null }
type Splitting = { index: number; boundary: number | null }

const DRAFT_CLOSED = " Draft not open, so only the recording's transcript changed."

/** Previous (muted), current (large) and next (muted) segment with "Wrong speaker?", split and merge corrections. */
export function NowSpeaking({ sessionId, segments, index, time, present, names, hasSpeakers, onReassign, onSplit, onMerge, onApplied }: NowSpeakingProps) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [splitting, setSplitting] = useState<Splitting | null>(null)
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState<Note | null>(null)
  const [error, setError] = useState('')
  const currentRef = useRef<HTMLParagraphElement>(null)
  // The shown sentence is frozen while a confirmation or split is open so edits hit what the user sees.
  const shown = pending?.index ?? splitting?.index ?? index
  const current = segments[shown]
  const currentText = current?.text ?? ''
  const canSplit = useMemo(() => sentenceWords(currentText).length >= 2, [currentText])
  const currentStart = current?.start ?? 0
  const currentEnd = current?.end ?? 0
  const showingText = splitting === null

  // Very long sentences scroll inside a capped box; keep the approximate playhead (by characters) in view.
  useEffect(() => {
    const box = currentRef.current
    if (!box || box.scrollHeight <= box.clientHeight || !(currentEnd > currentStart)) return
    const ratio = Math.min(1, Math.max(0, (time - currentStart) / (currentEnd - currentStart)))
    const target = ratio * box.scrollHeight
    if (target < box.scrollTop || target > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, target - box.clientHeight / 3)
  }, [time, currentStart, currentEnd, showingText])
  if (!current) return null
  const speaker = current.speaker ?? null
  const splitTarget = splitting ? segments[splitting.index] : undefined
  const at = shown

  async function perform(action: () => Promise<ReassignOutcome>, message: string, undo: (() => Promise<ReassignOutcome>) | null) {
    setPending(null)
    setSplitting(null)
    setWorking(true)
    setError('')
    try {
      const outcome = await action()
      confirmedSessions.add(sessionId)
      setNote({ text: `${message}${outcome.draftUpdated ? '' : DRAFT_CLOSED}`, undo })
      onApplied(outcome)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not change the speaker.')
    } finally { setWorking(false) }
  }

  function request(confirmLabel: string, run: () => Promise<void>) {
    setNote(null)
    if (confirmedSessions.has(sessionId)) void run()
    else setPending({ index: shown, confirmLabel, run })
  }

  async function undo() {
    const revert = note?.undo
    if (!revert) return
    setWorking(true)
    setError('')
    try {
      const outcome = await revert()
      setNote(null)
      onApplied(outcome)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not undo the change.')
    } finally { setWorking(false) }
  }

  function reassign(target: number) {
    request('Move sentence', () => perform(() => onReassign(at, target), `Moved to ${speakerDisplayName(target, names)}.`, null))
  }

  function split(sentence: number, offset: number, target: number) {
    request('Split sentence', () => perform(() => onSplit(sentence, offset, target), `Split. The rest is now ${speakerDisplayName(target, names)}.`, () => onMerge(sentence + 1)))
  }

  function merge() {
    const previous = segments[at - 1]
    if (!previous) return
    const offset = previous.text.length + 1
    const restoredSpeaker = current?.speaker ?? null
    request('Merge sentences', () => perform(() => onMerge(at), 'Merged with the previous sentence.', () => onSplit(at - 1, offset, restoredSpeaker)))
  }

  function startSplit() {
    setNote(null)
    const words = sentenceWords(currentText)
    setSplitting({ index: at, boundary: current ? nearestBoundary(words, current.text.length, current.start, current.end, time) : null })
  }

  const moveItems: RowMenuItem[] = reassignOptions(present, speaker).map((option) => ({
    key: String(option),
    label: present.includes(option) ? speakerDisplayName(option, names) : 'New speaker',
    leading: <i className="player-dot" style={{ background: speakerColor(option) }} aria-hidden="true" />,
    onSelect: () => reassign(option),
  }))

  return (
    <div className="player-now" aria-label="Now speaking">
      <p className="player-now-neighbour">{segments[shown - 1]?.text.trim() || ' '}</p>
      <div className="player-now-head">
        {speaker !== null && <i className="player-dot" style={{ background: speakerColor(speaker) }} aria-hidden="true" />}
        <strong title={speaker !== null ? speakerDisplayName(speaker, names) : undefined}>{speaker !== null ? speakerDisplayName(speaker, names) : 'Speaker unknown'}</strong>
        <time>{formatClock(current.start)}</time>
      </div>
      {splitting && splitTarget ? (
        <SplitSentence
          text={splitTarget.text}
          speaker={splitTarget.speaker ?? null}
          present={present}
          names={names}
          initialBoundary={splitting.boundary}
          onCancel={() => setSplitting(null)}
          onSubmit={(offset, target) => split(splitting.index, offset, target)}
        />
      ) : (
        <p className="player-now-current" ref={currentRef}>{current.text.trim()}</p>
      )}
      <p className="player-now-neighbour">{segments[shown + 1]?.text.trim() || ' '}</p>
      {hasSpeakers && (
        <div className="player-reassign" role="group" aria-label="Fix this sentence">
          <RowMenu
            label="Move this sentence to"
            triggerLabel="Wrong speaker? Move this sentence to another speaker"
            triggerText={<>
              {speaker !== null && <i className="player-dot" style={{ background: speakerColor(speaker) }} aria-hidden="true" />}
              Speaker<ChevronIcon />
            </>}
            triggerClassName="player-reassign-trigger"
            disabled={working}
            items={moveItems}
          />
          <button
            type="button"
            className="player-reassign-trigger"
            title="Split this sentence where another speaker starts"
            aria-label="Split this sentence where another speaker starts"
            aria-pressed={splitting !== null}
            disabled={working || (splitting === null && !canSplit)}
            onClick={() => (splitting !== null ? setSplitting(null) : startSplit())}
          ><ScissorsIcon />Split</button>
          {shown > 0 && (
            <button
              type="button"
              className="player-reassign-trigger"
              title="Merge with the previous sentence"
              aria-label="Merge with the previous sentence"
              disabled={working || splitting !== null}
              onClick={merge}
            ><MergeUpIcon />Merge</button>
          )}
        </div>
      )}
      {pending && (
        <div className="player-reassign-confirm" role="group" aria-label="Confirm speaker change">
          <p>Editing speakers rebuilds the Transcript section of the draft. Edits you made inside that section will be replaced.</p>
          <button type="button" onClick={() => setPending(null)}>Cancel</button>
          <button type="button" className="transcription-retranscribe-confirm-button" onClick={() => void pending.run()}>{pending.confirmLabel}</button>
        </div>
      )}
      {note && (
        <p className="player-note" role="status">
          {note.text}
          {note.undo && <> <button type="button" className="player-note-undo" disabled={working} onClick={() => void undo()}>Undo</button></>}
        </p>
      )}
      {error && <p className="transcription-item-error" role="alert">{error}</p>}
    </div>
  )
}
