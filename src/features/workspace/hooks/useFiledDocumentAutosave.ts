import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export type FiledDocumentSaveState = {
  dirty: boolean;
  saving: boolean;
};

export type FiledDocumentAutosaveOptions = {
  save: (documentId: string, content: string) => Promise<void>;
  delayMs?: number;
  onSaveError?: (documentId: string, error: unknown) => void;
  onSaveStateChange?: (
    documentId: string,
    state: FiledDocumentSaveState,
  ) => void;
};

export type FiledDocumentAutosave = {
  scheduleSave: (documentId: string, content: string) => void;
  flushSave: (documentId: string) => Promise<void>;
  flushAllSaves: () => Promise<void>;
  isDirty: (documentId: string) => boolean;
};

type PendingSave = {
  content: string;
  revision: number;
};

type DocumentSaveRecord = {
  nextRevision: number;
  pending: PendingSave | undefined;
  inFlight: PendingSave | undefined;
  savePromise: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  followUpAfterFlight: boolean;
  dirty: boolean;
};

const DEFAULT_DELAY_MS = 500;

/**
 * Coordinates autosaves for filed documents without allowing concurrent saves
 * for the same document. The caller owns optimistic UI updates; this hook only
 * owns delivery of the newest content snapshot.
 */
export function useFiledDocumentAutosave({
  save,
  delayMs = DEFAULT_DELAY_MS,
  onSaveError,
  onSaveStateChange,
}: FiledDocumentAutosaveOptions): FiledDocumentAutosave {
  const recordsRef = useRef(new Map<string, DocumentSaveRecord>());
  const saveRef = useRef(save);
  const errorRef = useRef(onSaveError);
  const stateRef = useRef(onSaveStateChange);

  useLayoutEffect(() => {
    saveRef.current = save;
    errorRef.current = onSaveError;
    stateRef.current = onSaveStateChange;
  }, [onSaveError, onSaveStateChange, save]);

  const reportState = useCallback((documentId: string, record: DocumentSaveRecord) => {
    stateRef.current?.(documentId, {
      dirty: record.dirty,
      saving: record.inFlight !== undefined,
    });
  }, []);

  const getRecord = useCallback((documentId: string) => {
    const existing = recordsRef.current.get(documentId);
    if (existing) return existing;

    const record: DocumentSaveRecord = {
      nextRevision: 0,
      pending: undefined,
      inFlight: undefined,
      savePromise: undefined,
      timer: undefined,
      followUpAfterFlight: false,
      dirty: false,
    };
    recordsRef.current.set(documentId, record);
    return record;
  }, []);

  const clearTimer = useCallback((record: DocumentSaveRecord) => {
    if (record.timer === undefined) return;
    clearTimeout(record.timer);
    record.timer = undefined;
  }, []);

  const startSaveRef = useRef<(documentId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );

  const startSave = useCallback(
    (documentId: string): Promise<void> => {
      const record = getRecord(documentId);
      clearTimer(record);
      if (record.savePromise) return record.savePromise;
      if (!record.pending) return Promise.resolve();

      const snapshot = record.pending;
      record.pending = undefined;
      record.inFlight = snapshot;
      reportState(documentId, record);

      const savePromise = Promise.resolve()
        .then(() => saveRef.current(documentId, snapshot.content))
        .catch((error: unknown) => {
          errorRef.current?.(documentId, error);
          // Do not let a failed response erase a newer local edit. If there is
          // no newer edit, retain this exact snapshot as dirty for a later retry.
          if (!record.pending) record.pending = snapshot;
        })
        .then(() => {
          const hadFollowUp = record.followUpAfterFlight;
          record.followUpAfterFlight = false;
          record.inFlight = undefined;
          record.savePromise = undefined;
          record.dirty = record.pending !== undefined;
          reportState(documentId, record);

          // An edit (or an explicit flush) while a request was in flight should
          // send exactly the newest pending snapshot as soon as that request ends.
          if (hadFollowUp && record.pending) {
            return startSaveRef.current(documentId);
          }
          return undefined;
        });
      record.savePromise = savePromise;
      return savePromise;
    },
    [clearTimer, getRecord, reportState],
  );

  useLayoutEffect(() => {
    startSaveRef.current = startSave;
  }, [startSave]);

  const scheduleSave = useCallback(
    (documentId: string, content: string) => {
      const record = getRecord(documentId);
      clearTimer(record);
      record.pending = { content, revision: record.nextRevision + 1 };
      record.nextRevision += 1;
      record.dirty = true;
      if (record.inFlight) record.followUpAfterFlight = true;
      reportState(documentId, record);
      record.timer = setTimeout(() => {
        record.timer = undefined;
        void startSaveRef.current(documentId);
      }, delayMs);
    },
    [clearTimer, delayMs, getRecord, reportState],
  );

  const flushSave = useCallback(
    async (documentId: string) => {
      const record = getRecord(documentId);
      clearTimer(record);
      if (record.inFlight) {
        record.followUpAfterFlight = true;
        await record.savePromise;
        return;
      }
      await startSaveRef.current(documentId);
    },
    [clearTimer, getRecord],
  );

  const flushAllSaves = useCallback(async () => {
    await Promise.all(
      Array.from(recordsRef.current.keys(), (documentId) =>
        flushSave(documentId),
      ),
    );
  }, [flushSave]);

  const isDirty = useCallback(
    (documentId: string) => getRecord(documentId).dirty,
    [getRecord],
  );

  useEffect(
    () => () => {
      // React cleanup cannot await. Starting the flush here gives navigation and
      // unmount the same best-effort persistence guarantee as an explicit flush.
      void flushAllSaves();
    },
    [flushAllSaves],
  );

  return { scheduleSave, flushSave, flushAllSaves, isDirty };
}
