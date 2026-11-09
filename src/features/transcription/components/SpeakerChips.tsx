import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { playbackStore } from '../model/playback-store.ts'
import { speakerColor, speakerDisplayName } from '../model/playback-turns.ts'
import { MAX_SPEAKER_NAME_LENGTH } from '../model/speakers.ts'
import { PencilIcon } from './icons.tsx'

type SpeakerChipsProps = {
  speakers: readonly number[]
  names: ReadonlyMap<number, string> | null
  counts: ReadonlyMap<number, number>
  solo: number | null
  active: boolean
  onRename: (speaker: number, name: string) => Promise<void>
}

/** Solo chips for each speaker; the pencil beside a chip renames that speaker in the linked draft. */
export function SpeakerChips({ speakers, names, counts, solo, active, onRename }: SpeakerChipsProps) {
  const [editing, setEditing] = useState<number | null>(null)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const finishedRef = useRef(true)

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
      setNote('Renamed in the draft.')
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
      <div className="player-chips" role="group" aria-label="Play one speaker">
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
            <span key={speaker} className={`player-chip-group${solo === speaker ? ' is-solo' : ''}`}>
              <button
                type="button"
                className="player-chip"
                aria-pressed={solo === speaker}
                onClick={() => playbackStore.setSolo(solo === speaker ? null : speaker)}
                disabled={!active}
              >
                {dot}
                {name} · {counts.get(speaker) ?? 0}
              </button>
              <button type="button" className="player-chip-edit" aria-label={`Rename ${name}`} title={`Rename ${name}`} onClick={() => startEditing(speaker)} disabled={saving}>
                <PencilIcon />
              </button>
            </span>
          )
        })}
      </div>
      {note && <p className="player-note" role="status">{note}</p>}
      {error && <p className="transcription-item-error" role="alert">{error}</p>}
    </>
  )
}
