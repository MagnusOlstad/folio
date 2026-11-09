import { useEffect, useId, useRef } from 'react'
import type { TranscriptionDockActions, TranscriptionDockModel } from '../hooks/useTranscription.ts'
import type { SpeakerModelStatus, TranscriptionSession } from '../model/types.ts'
import { formatClock } from '../model/playback-turns.ts'
import { ChevronIcon, PauseIcon, PlayIcon, WaveIcon } from './icons.tsx'
import { PlayerPanel } from './PlayerPanel.tsx'
import { RowMenu, type RowMenuItem } from './RowMenu.tsx'

export type RowConfirmation = 'delete' | 'retranscribe'

type RecordingRowProps = {
  session: TranscriptionSession
  model: TranscriptionDockModel
  actions: TranscriptionDockActions
  speakers: SpeakerModelStatus | undefined
  speakersReady: boolean
  selectedModelName: string
  canTranscribe: boolean
  controlsBusy: boolean
  busy: boolean
  expanded: boolean
  playing: boolean
  speakerCount: number | null
  confirming: RowConfirmation | null
  onConfirm: (value: RowConfirmation | null) => void
  onToggleExpand: () => void
  onSpeakerCount: (count: number) => void
  onTogglePlay: () => void
}

function durationLabel(durationMs: number | null) {
  return durationMs === null ? 'Duration unavailable' : formatClock(durationMs / 1000)
}

export function RecordingRow(props: RecordingRowProps) {
  const { session, model, actions, speakers, speakersReady, selectedModelName, canTranscribe, controlsBusy, busy, expanded, playing, speakerCount, confirming, onConfirm } = props
  const panelId = useId()
  const name = session.fileName || 'audio recording'
  const cancelRef = useRef<HTMLButtonElement>(null)
  const wasDeletingRef = useRef(false)
  const processing = session.state === 'transcribing' || (busy && model.activeSession?.id === session.id && model.phase === 'transcribing')
  const summarizing = busy && model.activeSession?.id === session.id && (model.phase === 'summarizing' || model.phase === 'cancelling-summary')
  const deleting = model.deletingSessionId === session.id
  const ready = session.state === 'ready'
  const speakersBlocked = session.identifySpeakers === true && Boolean(speakers) && !speakersReady
  const deleteDisabled = controlsBusy || model.recording.phase !== 'idle' || processing || summarizing || Boolean(model.deletingSessionId)
  const draftOpen = ready && model.speakerNamesFor(session) !== null

  useEffect(() => { if (confirming === 'delete') cancelRef.current?.focus() }, [confirming])
  useEffect(() => {
    if (wasDeletingRef.current && !deleting && confirming === 'delete') cancelRef.current?.focus()
    wasDeletingRef.current = deleting
  }, [deleting, confirming])

  let meta: string
  if (processing) meta = `Transcribing… ${session.progressPercent ?? 0}%`
  else if (summarizing) meta = 'Summarizing…'
  else if (session.state === 'failed') meta = session.error || 'Transcription failed'
  else if (ready) {
    meta = [durationLabel(session.durationMs), speakerCount ? `${speakerCount} ${speakerCount === 1 ? 'speaker' : 'speakers'}` : '', draftOpen ? 'draft open' : ''].filter(Boolean).join(' · ')
  } else meta = `${durationLabel(session.durationMs)} · not transcribed`

  function speakerOption() {
    if (!speakers) return null
    return (
      <label className="transcription-item-speakers">
        <input
          type="checkbox"
          aria-label={`Identify speakers in ${name}`}
          checked={session.identifySpeakers === true}
          onChange={(event) => actions.setSessionIdentifySpeakers(session, event.currentTarget.checked)}
          disabled={controlsBusy || processing}
        />
        <span>Identify speakers</span>
        <small>{`up to ${speakers.maxSpeakers} · slower`}</small>
      </label>
    )
  }

  const items: RowMenuItem[] = []
  if (ready) {
    items.push(
      { key: 'open', label: 'Open draft', onSelect: () => actions.openTranscript(session), disabled: controlsBusy },
      { key: 'summarize', label: 'Summarize again', onSelect: () => actions.regenerateSummary(session), disabled: controlsBusy },
      { key: 'retranscribe', label: 'Re-transcribe…', onSelect: () => onConfirm('retranscribe'), disabled: controlsBusy || !canTranscribe },
    )
  } else if (speakers) {
    items.push({
      key: 'speakers', label: 'Identify speakers', ariaLabel: `Identify speakers in ${name}`,
      checked: session.identifySpeakers === true,
      onSelect: () => actions.setSessionIdentifySpeakers(session, session.identifySpeakers !== true),
      disabled: controlsBusy || processing,
    })
  }
  items.push({ key: 'delete', label: 'Delete…', onSelect: () => onConfirm('delete'), disabled: deleteDisabled, destructive: true })

  const lead = ready
    ? (
      <button type="button" className="transcription-icon-button transcription-play-button" aria-label={playing ? `Pause ${name}` : `Play ${name}`} onClick={props.onTogglePlay}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
    )
    : <span className={`transcription-row-status${processing || summarizing ? ' is-busy' : ''}`} aria-hidden="true"><WaveIcon /></span>

  return (
    <li className={`transcription-row${expanded ? ' is-expanded' : ''}`}>
      <div className="transcription-row-line">
        {lead}
        {ready ? (
          <button type="button" className="transcription-row-main" onClick={props.onToggleExpand} aria-expanded={expanded} aria-controls={panelId} aria-label={`${name}, ${meta}`}>
            <span className="transcription-row-text">
              <strong title={session.fileName || 'Audio recording'}>{session.fileName || 'Audio recording'}</strong>
              <small>{meta}</small>
            </span>
            <span className="transcription-row-chevron" aria-hidden="true"><ChevronIcon /></span>
          </button>
        ) : (
          <div className="transcription-row-main">
            <strong title={session.fileName || 'Audio recording'}>{session.fileName || 'Audio recording'}</strong>
            <small role={processing || session.state === 'failed' ? 'status' : undefined}>{meta}</small>
          </div>
        )}
        {!ready && !processing && !summarizing && (
          <button type="button" className="transcription-row-action" onClick={() => actions.transcribe(session)} disabled={!canTranscribe || controlsBusy || speakersBlocked}>
            {session.state === 'failed' ? 'Retry' : 'Transcribe'}
          </button>
        )}
        {processing && <button type="button" className="transcription-row-action" onClick={() => actions.cancel(session)}>Cancel</button>}
        {summarizing && (
          <button type="button" className="transcription-row-action" onClick={() => actions.cancel(session)} disabled={model.phase === 'cancelling-summary'}>
            {model.phase === 'cancelling-summary' ? 'Cancelling…' : 'Cancel summary'}
          </button>
        )}
        <RowMenu label={`More actions for ${name}`} items={items} />
      </div>
      {ready && expanded && <PlayerPanel id={panelId} session={session} model={model} actions={actions} onSpeakerCount={props.onSpeakerCount} />}
      {speakersBlocked && <p className="transcription-item-error" role="status">Speaker labels need the {speakers?.modelName} model. Download it above, or turn speaker labels off for this audio.</p>}
      {ready && confirming === 'retranscribe' && (
        <div className="transcription-retranscribe-confirm" role="group" aria-label={`Confirm re-transcription of ${name}`}>
          <p>Transcribe again with {selectedModelName}? Only the Transcript section of the open draft is replaced; speaker names you set are kept.</p>
          {speakerOption()}
          <button type="button" onClick={() => onConfirm(null)}>Cancel</button>
          <button
            type="button"
            className="transcription-retranscribe-confirm-button"
            onClick={() => { onConfirm(null); actions.retranscribe(session) }}
            disabled={!canTranscribe || controlsBusy || speakersBlocked}
          >Re-transcribe</button>
        </div>
      )}
      {confirming === 'delete' && (
        <div className="transcription-delete-confirm" role="group" aria-label={`Confirm deletion of ${name}`}>
          <p>Delete this local audio, transcript, and summary? Any opened or saved Markdown note will be kept.</p>
          {deleting ? <span role="status">Deleting local session…</span> : <>
            <button ref={cancelRef} type="button" onClick={() => onConfirm(null)} disabled={deleteDisabled}>Cancel</button>
            <button type="button" className="transcription-delete-confirm-button" onClick={() => void actions.deleteSession(session)} disabled={deleteDisabled}>Delete recording</button>
          </>}
        </div>
      )}
    </li>
  )
}
