import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent } from 'react'
import type { TranscriptionDockActions, TranscriptionDockModel } from '../hooks/useTranscription.ts'
import { usePlayerResult } from '../hooks/usePlayerResult.ts'
import { playbackStore } from '../model/playback-store.ts'
import {
  buildTurns, findSegmentIndex, formatClock, segmentSpeakers, totalDuration, turnCounts,
} from '../model/playback-turns.ts'
import type { TranscriptionSession } from '../model/types.ts'
import { NextIcon, PauseIcon, PlayIcon, PrevIcon } from './icons.tsx'
import { NowSpeaking } from './NowSpeaking.tsx'
import { SpeakerChips } from './SpeakerChips.tsx'
import { SpeakerLanes } from './SpeakerLanes.tsx'
import { normalizeSpeakerName } from '../model/speakers.ts'

type PlayerPanelProps = {
  id: string
  session: TranscriptionSession
  model: TranscriptionDockModel
  actions: TranscriptionDockActions
  onSpeakerCount: (count: number) => void
}

export function PlayerPanel({ id, session, model, actions, onSpeakerCount }: PlayerPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const playback = useSyncExternalStore(playbackStore.subscribe, playbackStore.getSnapshot)
  const { result, error, setResult } = usePlayerResult(session, actions.loadResult)
  const draftNames = model.speakerNamesFor(session)
  // Names just saved fill in until the draft adapter reports them (a draft created by the rename can lag a render).
  const [renamed, setRenamed] = useState<ReadonlyMap<number, string>>(new Map())
  const names = useMemo(() => renamed.size ? new Map([...renamed, ...(draftNames ?? [])]) : draftNames, [draftNames, renamed])
  const segments = useMemo(() => result?.segments ?? [], [result])
  const turns = useMemo(() => buildTurns(segments), [segments])
  const speakers = useMemo(() => segmentSpeakers(segments), [segments])
  const counts = useMemo(() => turnCounts(turns), [turns])
  const hasSpeakers = speakers.length > 0
  const audioUrl = model.audioUrlFor(session)
  const active = playback.sessionId === session.id
  const time = active ? playback.currentTime : 0
  const duration = totalDuration(segments, active ? playback.duration : 0, session.durationMs === null ? null : session.durationMs / 1000)
  const segmentIndex = segments.length ? Math.max(0, findSegmentIndex(segments, time)) : -1
  const solo = active ? playback.solo : null

  useEffect(() => {
    playbackStore.load(session.id, audioUrl, (session.durationMs ?? 0) / 1000)
  }, [session.id, audioUrl, session.durationMs])
  useEffect(() => { playbackStore.setTurns(session.id, turns) }, [session.id, turns])
  useEffect(() => { if (speakers.length) onSpeakerCount(speakers.length) }, [speakers.length, onSpeakerCount])

  async function renameSpeaker(speaker: number, name: string) {
    await actions.renameSpeaker(session, speaker, name)
    setRenamed((current) => new Map(current).set(speaker, normalizeSpeakerName(speaker, name)))
  }

  function focusPanel() { rootRef.current?.focus() }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (event.key !== ' ' || /^(BUTTON|SELECT|INPUT|TEXTAREA)$/.test(target.tagName)) return
    event.preventDefault()
    playbackStore.toggle()
  }

  return (
    <div className="player-panel" id={id} ref={rootRef} role="group" aria-label={`Player for ${session.fileName || 'audio recording'}`} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="player-transport">
        <button type="button" className="transcription-icon-button" aria-label="Previous turn" title="Previous turn" onClick={() => playbackStore.skipTurn(-1)} disabled={!active || !turns.length}><PrevIcon /></button>
        <button type="button" className="transcription-icon-button player-play" aria-label={active && playback.playing ? 'Pause' : 'Play'} onClick={() => playbackStore.toggle()} disabled={!active}>
          {active && playback.playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
        <button type="button" className="transcription-icon-button" aria-label="Next turn" title="Next turn" onClick={() => playbackStore.skipTurn(1)} disabled={!active || !turns.length}><NextIcon /></button>
        <span className="player-time">{formatClock(time)} / {formatClock(duration)}</span>
        <button type="button" className="player-rate" aria-label={`Playback speed ${playback.rate}×`} title="Playback speed" onClick={() => playbackStore.cycleRate()}>{playback.rate}×</button>
      </div>

      {hasSpeakers ? (
        <SpeakerLanes
          turns={turns}
          speakers={speakers}
          names={names}
          duration={duration}
          time={time}
          solo={solo}
          onSeek={(seconds, source) => { playbackStore.seekCurrent(seconds); if (source === 'pointer') focusPanel() }}
        />
      ) : (
        <input
          type="range"
          className="player-scrub"
          aria-label="Seek"
          min={0}
          max={Math.max(1, Math.floor(duration))}
          step={1}
          value={Math.min(Math.floor(time), Math.max(1, Math.floor(duration)))}
          onChange={(event) => playbackStore.seekCurrent(Number(event.currentTarget.value))}
          disabled={!active}
        />
      )}

      {hasSpeakers && <SpeakerChips speakers={speakers} names={names} counts={counts} solo={solo} active={active} onRename={renameSpeaker} />}

      {error && <p className="transcription-item-error" role="status">{error}</p>}
      {result && segments.length > 0 && (
        <NowSpeaking
          sessionId={session.id}
          segments={segments}
          index={segmentIndex}
          present={speakers}
          names={names}
          hasSpeakers={hasSpeakers}
          time={time}
          onReassign={(index, speaker) => actions.reassignSpeaker(session, index, speaker)}
          onSplit={(index, offset, speaker) => actions.splitSegment(session, index, offset, speaker)}
          onMerge={(index) => actions.mergeSegment(session, index)}
          onApplied={(outcome) => setResult(outcome.result)}
        />
      )}
      {result && segments.length === 0 && <p className="transcription-empty">This recording has no timed segments to follow.</p>}
    </div>
  )
}
