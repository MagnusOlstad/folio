import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { playbackStore } from '../model/playback-store.ts'
import { speakerColor, speakerDisplayName } from '../model/playback-turns.ts'
import { MAX_SPEAKER_NAME_LENGTH } from '../model/speakers.ts'
import { PencilIcon } from './icons.tsx'
import type { ReassignOutcome } from '../hooks/speakerReassign.ts'
import type { TranscriptionResult } from '../model/types.ts'

type SpeakerChipsProps = {
  speakers: readonly number[]
  names: ReadonlyMap<number, string> | null
  counts: ReadonlyMap<number, number>
  solo: number | null
  active: boolean
  onRename: (speaker: number, name: string) => Promise<TranscriptionResult>
  onMerge: (source: number, target: number) => Promise<ReassignOutcome>
  onApplied: (outcome: ReassignOutcome, source: number, target: number) => void
}

/** Solo chips for each speaker; the pencil beside a chip renames that recording speaker. */
export function SpeakerChips({ speakers, names, counts, solo, active, onRename, onMerge, onApplied }: SpeakerChipsProps) {
  const [editing, setEditing] = useState<number | null>(null)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const [mergeCount, setMergeCount] = useState(0)
  const [error, setError] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const focusIntent = useRef<'trigger' | null>(null)
  const focusTarget = useRef<HTMLButtonElement | null>(null)
  const statusRef = useRef<HTMLParagraphElement | null>(null)
  const finishedRef = useRef(true)

  function cancelMerge(restoreFocus = true) { if (restoreFocus) focusIntent.current = 'trigger'; setSelecting(false); setSelected([]); setError('') }
  function cancelOnEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && selecting && !saving) { event.preventDefault(); event.stopPropagation(); cancelMerge() }
  }
  useEffect(() => { if (mergeCount > 0) statusRef.current?.focus() }, [mergeCount])
  useEffect(() => {
    if (selecting) return
    if (focusIntent.current === 'trigger') {
      focusTarget.current?.focus()
      focusIntent.current = null
    }
  }, [selecting])
  function toggleSelection(speaker: number) {
    setSelected((current) => {
      if (current.includes(speaker)) return current.filter((item) => item !== speaker)
      if (current.length >= 2) return [current[1], speaker]
      return [...current, speaker]
    })
  }
  async function confirmMerge() {
    if (selected.length !== 2 || saving) return
    const [target, source] = selected
    if (target === undefined || source === undefined) return
    setSaving(true); setError('')
    try {
      const outcome = await onMerge(source, target)
      onApplied(outcome, source, target)
      setNote('Speakers merged in the recording.')
      setMergeCount((count) => count + 1)
      cancelMerge(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not merge speakers.') }
    finally { setSaving(false) }
  }

  function startEditing(speaker: number) {
    finishedRef.current = false
    setNote('')
    setError('')
    setValue(speakerDisplayName(speaker, names))
    setEditing(speaker)
  }

  async function finish(speaker: number, save: boolean) {
    if (finishedRef.current) return
    finishedRef.current = true
    setEditing(null)
    if (!save) return
    const next = value.replace(/\s+/g, ' ').trim()
    if ((next || `Speaker ${speaker}`) === speakerDisplayName(speaker, names)) return
    setSaving(true)
    try {
      await onRename(speaker, next)
      setNote('Name saved to the recording.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not rename the speaker.')
    } finally { setSaving(false) }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, speaker: number) {
    if (event.key === 'Enter') { event.preventDefault(); void finish(speaker, true) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void finish(speaker, false) }
  }

  return (
    <>
      <div className={`player-chips${selecting ? ' is-merging' : ''}`} role="group" aria-label={selecting ? 'Select two speakers to merge' : 'Play one speaker'} onKeyDown={cancelOnEscape}>
        {speakers.map((speaker) => {
          const name = speakerDisplayName(speaker, names)
          const dot = <i className="player-dot" style={{ background: speakerColor(speaker) }} aria-hidden="true" />
          if (editing === speaker) {
            return (
              <span key={speaker} className="player-chip-group is-editing">
                {dot}
                <input
                  className="player-chip-input"
                  aria-label={`Name for ${name}`}
                  value={value}
                  maxLength={MAX_SPEAKER_NAME_LENGTH}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setValue(event.currentTarget.value)}
                  onKeyDown={(event) => onKeyDown(event, speaker)}
                  onBlur={() => void finish(speaker, true)}
                />
              </span>
            )
          }
          return (
              <span key={speaker} className={`player-chip-group${selecting ? (selected.includes(speaker) ? ' is-merge-selected' : '') : solo === speaker ? ' is-solo' : ''}`}>
              <button
                type="button"
                className="player-chip"
                aria-pressed={selecting ? selected.includes(speaker) : solo === speaker}
                onClick={() => selecting ? toggleSelection(speaker) : playbackStore.setSolo(solo === speaker ? null : speaker)}
                disabled={selecting ? saving : !active}
              >
                {dot}
                <span className="player-chip-name" title={name}>{name}</span>{' '}
                <span className="player-chip-count">· {counts.get(speaker) ?? 0}</span>
              </button>
              {!selecting && <button type="button" className="player-chip-edit" aria-label={`Rename ${name}`} title={`Rename ${name}`} onClick={() => startEditing(speaker)} disabled={saving}>
                <PencilIcon />
              </button>}
            </span>
          )
        })}
      </div>
      {speakers.length >= 2 && <div className="player-merge-controls" onKeyDown={cancelOnEscape}>
        {!selecting ? <button ref={focusTarget} type="button" className="player-merge-trigger" onClick={() => { setError(''); setNote(''); setSelecting(true) }} disabled={saving}>Merge speakers</button> : <>
          <span className="player-merge-hint">Select two speakers to merge.</span>
          <button type="button" className="player-merge-confirm" onClick={() => void confirmMerge()} disabled={selected.length !== 2 || saving}>{saving ? 'Merging…' : 'Merge'}</button>
          <button type="button" className="player-merge-cancel" onClick={() => cancelMerge()} disabled={saving}>Cancel</button>
        </>}
      </div>}
      {note && <p ref={statusRef} className="player-note" role="status" tabIndex={-1}>{note}</p>}
      {error && <p className="transcription-item-error" role="alert">{error}</p>}
    </>
  )
}
