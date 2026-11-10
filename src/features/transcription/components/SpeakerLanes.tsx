import { memo, useMemo, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { barPercent, keyboardSeekTarget, laneBars, type LaneBar } from '../model/lane-bars.ts'
import { formatClock, laneTimeAt, speakerColor, speakerDisplayName, type Turn } from '../model/playback-turns.ts'

export type SeekSource = 'pointer' | 'keyboard'

type SpeakerLanesProps = {
  turns: readonly Turn[]
  speakers: readonly number[]
  names: ReadonlyMap<number, string> | null
  duration: number
  time: number
  solo: number | null
  onSeek: (seconds: number, source: SeekSource) => void
}

type LaneBarsProps = { speaker: number; bars: readonly LaneBar[]; duration: number }

/** Bars only change with the result, so playback ticks never re-render them. */
const LaneBars = memo(function LaneBars({ speaker, bars, duration }: LaneBarsProps) {
  const background = speakerColor(speaker)
  return (
    <>
      {bars.map((bar) => {
        const { left, width } = barPercent(bar, duration)
        return <i key={bar.start} className="player-lane-bar" style={{ left: `${left}%`, width: `${width}%`, background }} />
      })}
    </>
  )
})

/** One thin lane per speaker with a shared playhead; clicking a lane or using the arrow keys seeks. */
export function SpeakerLanes({ turns, speakers, names, duration, time, solo, onSeek }: SpeakerLanesProps) {
  const bars = useMemo(() => laneBars(turns, speakers, duration), [turns, speakers, duration])
  const [hover, setHover] = useState<number | null>(null)
  const seconds = Math.min(Math.floor(time), Math.floor(duration))

  function fractionOf(event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    return box.width > 0 ? (event.clientX - box.left) / box.width : null
  }
  function seekFromPointer(event: MouseEvent<HTMLElement>) {
    const fraction = fractionOf(event)
    if (fraction !== null) onSeek(laneTimeAt(fraction, duration), 'pointer')
  }
  function trackMove(event: PointerEvent<HTMLElement>) {
    const fraction = fractionOf(event)
    const next = fraction === null ? null : Math.floor(laneTimeAt(fraction, duration))
    setHover((current) => (current === next ? current : next))
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = keyboardSeekTarget(event.key, event.shiftKey, time, duration)
    if (target === null) return
    event.preventDefault()
    onSeek(target, 'keyboard')
  }

  const playhead = duration > 0 ? Math.min(100, (time / duration) * 100) : 0
  return (
    <div
      className="player-lanes"
      data-testid="speaker-lanes"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.floor(duration)}
      aria-valuenow={Math.max(0, seconds)}
      aria-valuetext={formatClock(time)}
      onKeyDown={onKeyDown}
    >
      {speakers.map((speaker) => {
        const name = speakerDisplayName(speaker, names)
        return (
          <div className={`player-lane${solo !== null && solo !== speaker ? ' is-dimmed' : ''}`} key={speaker}>
            <span className="player-lane-name" title={name}>{name}</span>
            <div className="player-lane-track" data-lane={speaker} onClick={seekFromPointer} onPointerMove={trackMove} onPointerLeave={() => setHover(null)}>
              <LaneBars speaker={speaker} bars={bars.get(speaker) ?? []} duration={duration} />
            </div>
          </div>
        )
      })}
      <div className="player-playhead-layer" aria-hidden="true">
        <span className="player-playhead" style={{ left: `${playhead}%` }} />
        {hover !== null && duration > 0 && <span className="player-hover-time" style={{ left: `${Math.min(100, (hover / duration) * 100)}%` }}>{formatClock(hover)}</span>}
      </div>
    </div>
  )
}
