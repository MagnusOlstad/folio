import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TranscriptionResult, TranscriptionSession } from '../model/types.ts'

type Loaded = { key: string; result: TranscriptionResult | null; error: string }

/** Loads the stored result (segments, speakers) of the session shown in the player. */
export function usePlayerResult(session: TranscriptionSession, load: (session: TranscriptionSession) => Promise<TranscriptionResult | null>) {
  const key = `${session.id}:${session.updatedAt ?? ''}:${session.state}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // Session objects and action closures change identity on every poll; the key says when to reload.
  const latest = useRef({ session, load })
  useLayoutEffect(() => { latest.current = { session, load } })
  useEffect(() => {
    let cancelled = false
    latest.current.load(latest.current.session).then(
      (result) => { if (!cancelled) setLoaded({ key, result, error: '' }) },
      (error: unknown) => { if (!cancelled) setLoaded({ key, result: null, error: error instanceof Error ? error.message : 'Could not load the transcript.' }) },
    )
    return () => { cancelled = true }
  }, [key])
  const current = loaded?.key === key ? loaded : null
  return {
    result: current?.result ?? (loaded && loaded.key.startsWith(`${session.id}:`) ? loaded.result : null),
    error: current?.error ?? '',
    loading: current === null,
    setResult: (result: TranscriptionResult) => setLoaded({ key, result, error: '' }),
  }
}
