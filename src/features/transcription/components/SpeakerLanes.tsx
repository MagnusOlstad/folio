import type { MouseEvent } from 'react'
import { laneGeometry, laneTimeAt, speakerColor, speakerDisplayName, type Turn } from '../model/playback-turns.ts'

type SpeakerLanesProps = {
  turns: readonly Turn[]
  speakers: readonly number[]
  names: ReadonlyMap<number, string> | null
  duration: number
  time: number
  solo: number | null
  onSeek: (seconds: number) => void
}

/** One thin lane per speaker with a shared playhead; clicking a lane seeks. */
export function SpeakerLanes({ turns, speakers, names, duration, time, solo, onSeek }: SpeakerLanesProps) {
  function seekFromPointer(event: MouseEvent<HTMLElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    if (!(box.width > 0)) return
    onSeek(laneTimeAt((event.clientX - box.left) / box.width, duration))
  }
  const playhead = duration > 0 ? Math.min(100, (time / duration) * 100) : 0
  return (
    <div className="player-lanes" data-testid="speaker-lanes">
      {speakers.map((speaker) => (
        <div className={`player-lane${solo !== null && solo !== speaker ? ' is-dimmed' : ''}`} key={speaker}>
          <span className="player-lane-name" title={speakerDisplayName(speaker, names)}>{speakerDisplayName(speaker, names)}</span>
          <div className="player-lane-track" data-lane={speaker} onClick={seekFromPointer}>
            {turns.filter((turn) => turn.speaker === speaker).map((turn) => {
              const { left, width } = laneGeometry(turn, duration)
              return <i key={turn.start} className="player-lane-bar" style={{ left: `${left}%`, width: `${width}%`, background: speakerColor(speaker) }} />
            })}
          </div>
        </div>
      ))}
      <div className="player-playhead-layer" aria-hidden="true"><span className="player-playhead" style={{ left: `${playhead}%` }} /></div>
    </div>
  )
}
