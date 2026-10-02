import { useCallback, useEffect, useRef, useState } from 'react'
import { recordingBlobToWav, type RecordingAssociation } from '../model/recording.ts'

export type RecordingPhase = 'idle' | 'requesting' | 'recording' | 'processing' | 'ready'

type Options = {
  association: RecordingAssociation
  onImport: (file: File, association: RecordingAssociation) => Promise<boolean>
}

const MAX_RECORDING_MS = 40 * 60 * 1000
type RetainedRecording = { blob: Blob; association: RecordingAssociation; durationMs: number; file?: File }

function durationLabel(durationMs: number) {
  const seconds = Math.floor(durationMs / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function useAudioRecorder({ association, onImport }: Options) {
  const [phase, setPhase] = useState<RecordingPhase>('idle')
  const [durationMs, setDurationMs] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)
  const interval = useRef<number | null>(null)
  const importRef = useRef(onImport)
  const activeAssociation = useRef(association)
  const retained = useRef<RetainedRecording | null>(null)
  const discardOnStop = useRef(false)
  const mounted = useRef(true)
  const startPending = useRef(false)
  const cancelStart = useRef(false)
  const savingRef = useRef(false)
  const retryPending = useRef(false)

  useEffect(() => { importRef.current = onImport }, [onImport])
  const stopTracks = useCallback(() => {
    if (interval.current !== null) window.clearInterval(interval.current)
    interval.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const saveRetained = useCallback(async () => {
    const pending = retained.current
    if (!pending?.file || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const saved = await importRef.current(pending.file, pending.association)
      if (saved) {
        retained.current = null
        if (mounted.current) setPhase('idle')
      } else if (mounted.current) {
        setPhase('ready')
      }
    } catch (saveError) {
      if (mounted.current) setError(saveError instanceof Error ? saveError.message : 'Could not save the recording. Try again.')
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }, [])

  const finishRecording = useCallback(async () => {
    const allChunks = chunks.current
    const duration = Date.now() - startedAt.current
    const capturedAssociation = activeAssociation.current
    const mediaRecorder = recorder.current
    recorder.current = null
    stopTracks()
    if (mounted.current) {
      setDurationMs(duration)
      setPhase('processing')
    }
    if (discardOnStop.current) {
      chunks.current = []
      retained.current = null
      discardOnStop.current = false
      if (mounted.current) {
        setPhase('idle')
        setDurationMs(0)
      }
      return
    }
    try {
      if (!allChunks.length) throw new Error('No audio was captured. Check your microphone and try again.')
      const source = new Blob(allChunks, { type: mediaRecorder?.mimeType || allChunks[0]?.type || 'audio/webm' })
      const pending: RetainedRecording = { blob: source, association: capturedAssociation, durationMs: duration }
      retained.current = pending
      const wav = await recordingBlobToWav(source)
      const file = new File([wav], `Recording ${new Date().toLocaleString().replace(/[/:]/g, '-')}.wav`, {
        type: 'audio/wav',
        lastModified: Date.now(),
      })
      pending.file = file
      chunks.current = []
      if (mounted.current) {
        setPhase('ready')
        setError('')
      }
      await saveRetained()
    } catch (recordingError) {
      chunks.current = []
      if (mounted.current) {
        setError(recordingError instanceof Error ? recordingError.message : 'Could not finish the recording.')
        setDurationMs(retained.current?.durationMs ?? duration)
        setPhase(retained.current ? 'ready' : 'idle')
      }
    }
  }, [saveRetained, stopTracks])

  const start = useCallback(async () => {
    if (phase !== 'idle' || startPending.current || retryPending.current) return
    startPending.current = true
    cancelStart.current = false
    setError('')
    setDurationMs(0)
    discardOnStop.current = false
    setPhase('requesting')
    activeAssociation.current = association
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Microphone recording is not supported in this browser.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      startPending.current = false
      if (!mounted.current || cancelStart.current) {
        stream.getTracks().forEach((track) => track.stop())
        if (mounted.current) setPhase('idle')
        return
      }
      const mediaRecorder = new MediaRecorder(stream)
      recorder.current = mediaRecorder
      chunks.current = []
      startedAt.current = Date.now()
      activeAssociation.current = association
      mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.current.push(event.data)
      })
      mediaRecorder.addEventListener('stop', () => { void finishRecording() }, { once: true })
      mediaRecorder.addEventListener('error', () => {
        setError('The microphone recording stopped unexpectedly. Try again.')
        if (mediaRecorder.state !== 'inactive') mediaRecorder.stop()
      }, { once: true })
      mediaRecorder.start(1_000)
      setPhase('recording')
      interval.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAt.current
        setDurationMs(elapsed)
        if (elapsed >= MAX_RECORDING_MS && recorder.current?.state === 'recording') recorder.current.stop()
      }, 250)
    } catch (recordingError) {
      startPending.current = false
      stopTracks()
      setError(recordingError instanceof Error && recordingError.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow microphone access in system settings and try again.'
        : recordingError instanceof Error && recordingError.name === 'NotFoundError'
          ? 'No microphone was found. Connect a microphone and try again.'
          : recordingError instanceof Error ? recordingError.message : 'Could not access the microphone.')
      setPhase('idle')
    }
  }, [association, finishRecording, phase, stopTracks])

  const stop = useCallback(() => {
    if (startPending.current) {
      cancelStart.current = true
      return
    }
    if (recorder.current?.state === 'recording') {
      setPhase('processing')
      recorder.current.stop()
    }
  }, [])

  const discard = useCallback(() => {
    if (phase === 'processing' || retryPending.current) return
    retained.current = null
    if (recorder.current?.state === 'recording') {
      discardOnStop.current = true
      recorder.current.stop()
      stopTracks()
      setPhase('processing')
    } else {
      stopTracks()
      chunks.current = []
      setPhase('idle')
      setDurationMs(0)
    }
    setError('')
  }, [phase, stopTracks])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (recorder.current?.state === 'recording') recorder.current.stop()
      else if (!recorder.current) stopTracks()
    }
  }, [stopTracks])

  return {
    phase,
    duration: durationLabel(durationMs),
    durationMs,
    error,
    saving,
    start,
    stop,
    discard,
    retry: async () => {
      if (retryPending.current || savingRef.current) return
      retryPending.current = true
      const pending = retained.current
      if (pending && !pending.file) {
        setPhase('processing')
        try {
          const wav = await recordingBlobToWav(pending.blob)
          if (retained.current !== pending) return
          pending.file = new File([wav], `Recording ${new Date().toLocaleString().replace(/[/:]/g, '-')}.wav`, {
            type: 'audio/wav',
            lastModified: Date.now(),
          })
          setError('')
          if (mounted.current) setPhase('ready')
        } catch (conversionError) {
          if (retained.current === pending && mounted.current) {
            setError(conversionError instanceof Error ? conversionError.message : 'Could not convert the recording. Try again.')
            setPhase('ready')
          }
          return
        } finally {
          retryPending.current = false
        }
      }
      if (retained.current !== pending) {
        retryPending.current = false
        return
      }
      try { await saveRetained() } finally { retryPending.current = false }
    },
  }
}
