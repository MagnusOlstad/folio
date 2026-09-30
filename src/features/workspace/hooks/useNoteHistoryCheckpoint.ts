import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

type UseNoteHistoryCheckpointOptions = {
  checkpoint: (documentId: string, scopeId: string) => Promise<void | boolean>;
  onCheckpoint?: (documentId: string, scopeId: string) => void;
  onError?: (documentId: string, error: unknown) => void;
  intervalMs?: number;
};

type DirtyRevision = { documentId: string; revision: number };

/** Checkpoints edited filed notes periodically while an editing session remains active. */
export function useNoteHistoryCheckpoint({
  checkpoint,
  onCheckpoint,
  onError,
  intervalMs = 10 * 1000,
}: UseNoteHistoryCheckpointOptions) {
  const dirtyRevisionsRef = useRef(new Map<string, Map<string, DirtyRevision>>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const runningRef = useRef(false);
  const mountedRef = useRef(false);
  const checkpointRef = useRef(checkpoint);
  const onCheckpointRef = useRef(onCheckpoint);
  const errorRef = useRef(onError);
  const scheduleRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    checkpointRef.current = checkpoint;
    onCheckpointRef.current = onCheckpoint;
    errorRef.current = onError;
  }, [checkpoint, onCheckpoint, onError]);

  const schedule = useCallback(() => {
    if (!mountedRef.current || timerRef.current !== undefined || runningRef.current || dirtyRevisionsRef.current.size === 0) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      runningRef.current = true;
      const snapshot = Array.from(dirtyRevisionsRef.current.entries()).flatMap(([scopeId, documents]) =>
        Array.from(documents.values(), (dirty) => ({ ...dirty, scopeId })),
      );
      void Promise.all(snapshot.map(async ({ documentId, revision, scopeId }) => {
        try {
          const committed = await checkpointRef.current(documentId, scopeId);
          if (committed !== false) onCheckpointRef.current?.(documentId, scopeId);
          const scopedDirty = dirtyRevisionsRef.current.get(scopeId);
          if (scopedDirty?.get(documentId)?.revision === revision) {
            scopedDirty.delete(documentId);
            if (scopedDirty.size === 0) dirtyRevisionsRef.current.delete(scopeId);
          }
        } catch (error) {
          errorRef.current?.(documentId, error);
        }
      })).finally(() => {
        runningRef.current = false;
        if (mountedRef.current) scheduleRef.current();
      });
    }, intervalMs);
  }, [intervalMs]);

  useLayoutEffect(() => {
    scheduleRef.current = schedule;
  }, [schedule]);

  const markEdited = useCallback((documentId: string, scopeId: string) => {
    let scopedDirty = dirtyRevisionsRef.current.get(scopeId);
    if (!scopedDirty) {
      scopedDirty = new Map();
      dirtyRevisionsRef.current.set(scopeId, scopedDirty);
    }
    const revision = (scopedDirty.get(documentId)?.revision ?? 0) + 1;
    scopedDirty.set(documentId, { documentId, revision });
    schedule();
  }, [schedule]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    };
  }, []);

  return markEdited;
}
