import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

type UseNoteHistoryCheckpointOptions = {
  checkpoint: (documentId: string, scopeId: string) => Promise<void | boolean>;
  onCheckpoint?: (documentId: string, scopeId: string) => void;
  onError?: (documentId: string, error: unknown) => void;
  intervalMs?: number;
};

type DirtyRevision = { documentId: string; revision: number };
type CheckpointWaiter = { revision: number; resolve: (committed: boolean) => void };

function waiterKey(documentId: string, scopeId: string) {
  return `${scopeId}\0${documentId}`;
}

/** Checkpoints edited filed notes periodically while an editing session remains active. */
export function useNoteHistoryCheckpoint({
  checkpoint,
  onCheckpoint,
  onError,
  intervalMs = 60 * 1000,
}: UseNoteHistoryCheckpointOptions) {
  const dirtyRevisionsRef = useRef(new Map<string, Map<string, DirtyRevision>>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const periodicDeadlineRef = useRef<number | undefined>(undefined);
  const runningRef = useRef(false);
  const mountedRef = useRef(false);
  const checkpointRef = useRef(checkpoint);
  const onCheckpointRef = useRef(onCheckpoint);
  const errorRef = useRef(onError);
  const immediateRequestedRef = useRef(new Set<string>());
  const scheduleRef = useRef<(immediateDocument?: { documentId: string; scopeId: string }) => void>(() => undefined);
  const waitersRef = useRef(new Map<string, CheckpointWaiter[]>());

  useLayoutEffect(() => {
    checkpointRef.current = checkpoint;
    onCheckpointRef.current = onCheckpoint;
    errorRef.current = onError;
  }, [checkpoint, onCheckpoint, onError]);

  const schedule = useCallback((immediateDocument?: { documentId: string; scopeId: string }) => {
    if (!mountedRef.current) return;
    if (dirtyRevisionsRef.current.size === 0) {
      immediateRequestedRef.current.clear();
      periodicDeadlineRef.current = undefined;
      return;
    }
    if (immediateDocument) {
      immediateRequestedRef.current.add(waiterKey(immediateDocument.documentId, immediateDocument.scopeId));
    }
    if (runningRef.current) {
      return;
    }
    const immediate = immediateRequestedRef.current.size > 0;
    if (timerRef.current !== undefined) {
      if (!immediate) return;
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    const delay = immediate
      ? 0
      : Math.max(0, (periodicDeadlineRef.current ?? Date.now() + intervalMs) - Date.now());
    if (!immediate && periodicDeadlineRef.current === undefined) {
      periodicDeadlineRef.current = Date.now() + intervalMs;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      runningRef.current = true;
      const requested = new Set(immediateRequestedRef.current);
      immediateRequestedRef.current.clear();
      if (requested.size === 0) periodicDeadlineRef.current = undefined;
      const snapshot = Array.from(dirtyRevisionsRef.current.entries()).flatMap(([scopeId, documents]) =>
        Array.from(documents.values(), (dirty) => ({ ...dirty, scopeId })),
      ).filter(({ documentId, scopeId }) =>
        requested.size === 0 || requested.has(waiterKey(documentId, scopeId)),
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
          const key = waiterKey(documentId, scopeId);
          const waiters = waitersRef.current.get(key) ?? [];
          const remainingWaiters = waiters.filter((waiter) => {
            if (waiter.revision > revision) return true;
            waiter.resolve(committed !== false);
            return false;
          });
          if (remainingWaiters.length) waitersRef.current.set(key, remainingWaiters);
          else waitersRef.current.delete(key);
        } catch (error) {
          errorRef.current?.(documentId, error);
          const key = waiterKey(documentId, scopeId);
          const waiters = waitersRef.current.get(key) ?? [];
          const remainingWaiters = waiters.filter((waiter) => {
            if (waiter.revision > revision) return true;
            waiter.resolve(false);
            return false;
          });
          if (remainingWaiters.length) waitersRef.current.set(key, remainingWaiters);
          else waitersRef.current.delete(key);
        }
      })).finally(() => {
        runningRef.current = false;
        if (mountedRef.current) scheduleRef.current();
      });
    }, delay);
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

  const checkpointPending = useCallback((documentId: string, scopeId: string) => {
    const revision = dirtyRevisionsRef.current.get(scopeId)?.get(documentId)?.revision;
    if (revision === undefined) return Promise.resolve(true);
    const key = waiterKey(documentId, scopeId);
    return new Promise<boolean>((resolve) => {
      const waiters = waitersRef.current.get(key) ?? [];
      waiters.push({ revision, resolve });
      waitersRef.current.set(key, waiters);
      scheduleRef.current({ documentId, scopeId });
    });
  }, []);

  const checkpointScope = useCallback(async (scopeId: string) => {
    while (true) {
      const documentIds = Array.from(dirtyRevisionsRef.current.get(scopeId)?.keys() ?? []);
      if (documentIds.length === 0) return true;
      const outcomes = await Promise.all(documentIds.map((documentId) => checkpointPending(documentId, scopeId)));
      if (!outcomes.every(Boolean)) return false;
    }
  }, [checkpointPending]);

  useEffect(() => {
    mountedRef.current = true;
    scheduleRef.current();
    const waiters = waitersRef.current;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      for (const pending of waiters.values()) {
        for (const waiter of pending) waiter.resolve(false);
      }
      waiters.clear();
    };
  }, []);

  return { markEdited, checkpointPending, checkpointScope };
}
