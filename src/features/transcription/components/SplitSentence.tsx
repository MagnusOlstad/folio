import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { reassignOptions, speakerColor, speakerDisplayName } from '../model/playback-turns.ts'
import { sentenceWords } from '../model/split-sentence.ts'

type SplitSentenceProps = {
  text: string
  speaker: number | null
  present: readonly number[]
  names: ReadonlyMap<number, string> | null
  /** Word index preselected from the playhead, or null. */
  initialBoundary: number | null
  onCancel: () => void
  /** `offset` is the character offset of the first word of the rest, in `text`. */
  onSubmit: (offset: number, speaker: number) => void
}

/** Replaces the current sentence with clickable words: pick where the other speaker starts and who it is. */
export function SplitSentence({ text, speaker, present, names, initialBoundary, onCancel, onSubmit }: SplitSentenceProps) {
  const words = useMemo(() => sentenceWords(text), [text])
  const options = useMemo(() => reassignOptions(present, speaker), [present, speaker])
  const [boundary, setBoundary] = useState<number | null>(initialBoundary)
  const [target, setTarget] = useState<number | undefined>(options[0])
  const rest = target ?? speaker
  const wordsRef = useRef<HTMLParagraphElement>(null)

  // A preselected boundary may sit far down a long sentence; bring it into view inside the scroll box.
  useEffect(() => {
    if (boundary === null) return
    wordsRef.current?.querySelector<HTMLElement>('.is-boundary')?.scrollIntoView?.({ block: 'nearest' })
  }, [boundary])

  function optionLabel(option: number) { return present.includes(option) ? speakerDisplayName(option, names) : 'New speaker' }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }

  return (
    <div className="player-split" onKeyDown={onKeyDown}>
      <p className="player-now-current player-split-words" ref={wordsRef}>
        {words.map((word, index) => {
          const after = boundary !== null && index >= boundary
          const color = boundary === null ? undefined : after ? (rest === null ? undefined : speakerColor(rest)) : (speaker === null ? undefined : speakerColor(speaker))
          const style = color ? { color } : undefined
          return (
            <span key={word.offset}>
              {index > 0 && ' '}
              {index === 0 ? (
                <span className="player-split-word" style={style}>{word.text}</span>
              ) : (
                <button
                  type="button"
                  className={`player-split-word${index === boundary ? ' is-boundary' : ''}`}
                  style={style}
                  aria-label={`Split before "${word.text}"`}
                  aria-pressed={index === boundary}
                  onClick={() => setBoundary(index)}
                >{word.text}</button>
              )}
            </span>
          )
        })}
      </p>
      <p className="player-split-hint">Click the word where the other speaker starts.</p>
      <div className="player-split-who" role="group" aria-label="Who says the rest?">
        <span>Who says the rest?</span>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className="player-split-chip"
            aria-pressed={option === target}
            onClick={() => setTarget(option)}
          >
            <i className="player-dot" style={{ background: speakerColor(option) }} aria-hidden="true" />
            <span className="player-ellipsis" title={optionLabel(option)}>{optionLabel(option)}</span>
          </button>
        ))}
      </div>
      <div className="player-split-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="transcription-retranscribe-confirm-button"
          disabled={boundary === null || rest === null}
          onClick={() => { if (boundary !== null && rest !== null) onSubmit(words[boundary].offset, rest) }}
        >Split</button>
      </div>
    </div>
  )
}
