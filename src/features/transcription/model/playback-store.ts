// A small external store that owns the one audio element behind the recording player. The dock and the
// editor both read it through subscribe/getSnapshot (useSyncExternalStore) and drive it with commands.

import { adjacentTurnStart, soloStep, type Turn } from './playback-turns.ts'

export const PLAYBACK_RATES = [1, 1.5, 2] as const

export type PlaybackSnapshot = {
  sessionId: string | null
  currentTime: number
  duration: number
  playing: boolean
  rate: number
  /** Speaker number whose turns are played in isolation, or null. */
  solo: number | null
}

export type PlaybackResolvers = {
  /** Audio URL for a session; used when a seek targets a recording that is not loaded yet. */
  sourceFor?: (sessionId: string) => string | null
  /** The transcription session whose draft has this id, if the draft is still linked. */
  sessionForDraft?: (draftId: string) => string | null
}

const IDLE: PlaybackSnapshot = { sessionId: null, currentTime: 0, duration: 0, playing: false, rate: 1, solo: null }
const POLL_MS = 100

export function createPlaybackStore(createAudio: () => HTMLAudioElement = () => new Audio()) {
  let snapshot: PlaybackSnapshot = IDLE
  let audio: HTMLAudioElement | null = null
  let turns: readonly Turn[] = []
  let resolvers: PlaybackResolvers = {}
  let poll: number | null = null
  const listeners = new Set<() => void>()

  function update(patch: Partial<PlaybackSnapshot>) {
    const next = { ...snapshot, ...patch }
    if ((Object.keys(next) as (keyof PlaybackSnapshot)[]).every((key) => next[key] === snapshot[key])) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  function applySolo(element: HTMLAudioElement) {
    if (snapshot.solo === null || !turns.length) return
    const step = soloStep(turns, snapshot.solo, element.currentTime)
    if (step.kind === 'jump') element.currentTime = step.to
    else if (step.kind === 'end') element.pause()
  }

  function sync() {
    if (!audio) return
    if (!audio.paused) applySolo(audio)
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : snapshot.duration
    update({ currentTime: audio.currentTime || 0, duration, playing: !audio.paused && !audio.ended })
    if (!audio.paused && !audio.ended) {
      if (poll === null) poll = window.setInterval(sync, POLL_MS)
    } else if (poll !== null) { window.clearInterval(poll); poll = null }
  }

  function element() {
    if (audio) return audio
    audio = createAudio()
    audio.preload = 'metadata'
    for (const type of ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'playing', 'pause', 'ended', 'seeked']) {
      audio.addEventListener(type, sync)
    }
    return audio
  }

  function run(promise: unknown) {
    void Promise.resolve(promise).catch(() => { /* autoplay or load failures leave the player paused */ })
  }

  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    configure(next: PlaybackResolvers) { resolvers = next },
    sessionForDraft: (draftId: string) => resolvers.sessionForDraft?.(draftId) ?? null,

    load(sessionId: string, src: string, durationHint = 0) {
      if (snapshot.sessionId === sessionId && audio?.getAttribute('src') === src) return
      const media = element()
      media.pause()
      media.src = src
      media.defaultPlaybackRate = snapshot.rate
      media.playbackRate = snapshot.rate
      turns = []
      update({ sessionId, currentTime: 0, duration: durationHint, playing: false, solo: null })
    },
    unload(sessionId: string) {
      if (snapshot.sessionId !== sessionId) return
      if (audio) { audio.pause(); audio.removeAttribute('src') }
      turns = []
      if (poll !== null) { window.clearInterval(poll); poll = null }
      update({ ...IDLE, rate: snapshot.rate })
    },
    setTurns(sessionId: string, next: readonly Turn[]) {
      if (snapshot.sessionId === sessionId) turns = next
    },

    play() {
      if (!snapshot.sessionId) return
      const media = element()
      if (snapshot.solo !== null) {
        const step = soloStep(turns, snapshot.solo, media.currentTime)
        if (step.kind === 'end') media.currentTime = turns.find((turn) => turn.speaker === snapshot.solo)?.start ?? 0
      }
      run(media.play())
      sync()
    },
    pause() { if (audio) { audio.pause(); sync() } },
    toggle() { if (snapshot.playing) store.pause(); else store.play() },

    seek(sessionId: string, seconds: number, play = false) {
      if (snapshot.sessionId !== sessionId) {
        const src = resolvers.sourceFor?.(sessionId)
        if (!src) return false
        store.load(sessionId, src)
      }
      const media = element()
      const limit = snapshot.duration > 0 ? snapshot.duration : Number.POSITIVE_INFINITY
      media.currentTime = Math.max(0, Math.min(seconds, limit))
      update({ currentTime: media.currentTime })
      if (play) store.play()
      return true
    },
    /** Editor entry point: seeks the recording linked to a draft, else the loaded one, and plays. */
    seekFromDraft(draftId: string | undefined, seconds: number) {
      const sessionId = (draftId ? store.sessionForDraft(draftId) : null) ?? snapshot.sessionId
      return sessionId ? store.seek(sessionId, seconds, true) : false
    },
    seekCurrent(seconds: number) { return snapshot.sessionId ? store.seek(snapshot.sessionId, seconds) : false },
    skipTurn(direction: 1 | -1) {
      if (!snapshot.sessionId) return
      const target = adjacentTurnStart(turns, snapshot.currentTime, direction, snapshot.solo)
      if (target !== null) store.seek(snapshot.sessionId, target)
    },
    setRate(rate: number) {
      if (audio) { audio.defaultPlaybackRate = rate; audio.playbackRate = rate }
      update({ rate })
    },
    cycleRate() {
      const index = PLAYBACK_RATES.findIndex((rate) => rate === snapshot.rate)
      store.setRate(PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length])
    },
    setSolo(speaker: number | null) {
      update({ solo: speaker })
      if (audio && speaker !== null) { applySolo(audio); sync() }
    },
  }
  return store
}

export type PlaybackStore = ReturnType<typeof createPlaybackStore>

export const playbackStore: PlaybackStore = createPlaybackStore()
