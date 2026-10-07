import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StoredDraft, ViewerDocument } from "../../../domain/types.ts";
import { apiForBundle } from "../../../lib/api.ts";
import { loadLocalDrafts } from "../../../lib/storage.ts";
import {
  isUntitledId,
  storedDraftDocument,
} from "../../../lib/workspace.ts";
import { useWorkspacePersistence } from "./useWorkspacePersistence.ts";
import type { FilingQueueEntry } from "../model/filing.ts";

type UseWorkspaceDocumentStateOptions = {
  expandedDirectories: Set<string>;
  expandedDirectoriesReady: boolean;
  bundleId?: string;
  persistenceEnabled?: boolean;
};

export function useWorkspaceDocumentState({
  expandedDirectories,
  expandedDirectoriesReady,
  bundleId = "legacy-bundle",
  persistenceEnabled = true,
}: UseWorkspaceDocumentStateOptions) {
  const [documents, setDocuments] = useState<Record<string, ViewerDocument>>(
    () =>
      Object.fromEntries(
        loadLocalDrafts(bundleId).map((document) => [document.id, document]),
      ),
  );
  const [loadingDocuments, setLoadingDocuments] = useState<Set<string>>(
    () => new Set(),
  );
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.values(documents)
        .filter((document) => isUntitledId(document.id))
        .map((document) => [document.id, document.content]),
    ),
  );
  const draftsRef = useRef(drafts);
  const [savingDocuments, setSavingDocuments] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingDraftIds, setDeletingDraftIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [filingQueues, setFilingQueues] = useState<
    Record<string, FilingQueueEntry[]>
  >({});
  const directoryDeletions = useRef<Record<string, number>>({});
  const documentMutationSequence = useRef(0);
  const deletingDirectories = useRef(new Set<string>());
  const documentRequests = useRef<Record<string, number>>({});
  const saveQueues = useRef<Record<string, Promise<unknown>>>({});
  const draftSyncQueues = useRef<Record<string, Promise<void>>>({});
  const syncedDrafts = useRef(new Map<string, string>());
  const persistenceEnabledRef = useRef(persistenceEnabled);
  const activeBundleIdRef = useRef(bundleId);
  const filingDraftIds = useRef<Set<string>>(new Set());
  const documentsRef = useRef(documents);
  const draftSnapshotRef = useRef<StoredDraft[]>([]);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useLayoutEffect(() => {
    persistenceEnabledRef.current = persistenceEnabled;
    activeBundleIdRef.current = bundleId;
  }, [bundleId, persistenceEnabled]);

  const queueDraftSync = useCallback((draft: StoredDraft) => {
    if (!persistenceEnabledRef.current || filingDraftIds.current.has(draft.id))
      return Promise.resolve();
    const existingQueue =
      draftSyncQueues.current[draft.id] || Promise.resolve();
    const sync = existingQueue
      .catch(() => undefined)
      .then(async () => {
        if (!persistenceEnabledRef.current || filingDraftIds.current.has(draft.id)) return;
        const isNonempty = Boolean(draft.content.trim());
        const signature = isNonempty ? JSON.stringify(draft) : "DELETE";
        const syncKey = `${bundleId}\u0000${draft.id}`;
        if (syncedDrafts.current.get(syncKey) === signature) return;
        await apiForBundle<StoredDraft>(
          bundleId === "legacy-bundle" ? null : bundleId,
          `/api/draft?id=${encodeURIComponent(draft.id)}`,
          {
            method: isNonempty ? "PUT" : "DELETE",
            ...(isNonempty ? { body: JSON.stringify(draft) } : {}),
          },
        );
        const currentDraft = draftSnapshotRef.current.find(
          (snapshot) => snapshot.id === draft.id,
        );
        if (
          activeBundleIdRef.current === bundleId &&
          currentDraft &&
          (currentDraft.content.trim() ? JSON.stringify(currentDraft) : "DELETE") === signature
        ) {
          syncedDrafts.current.set(syncKey, signature);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (draftSyncQueues.current[draft.id] === sync)
          delete draftSyncQueues.current[draft.id];
      });
    draftSyncQueues.current[draft.id] = sync;
    return sync;
  }, [bundleId]);

  function mergeRemoteDrafts(remoteDrafts: StoredDraft[]) {
    const currentDocuments = documentsRef.current;
    const acceptedDrafts = remoteDrafts.filter((draft) => {
      if (!draft.content.trim() || filingDraftIds.current.has(draft.id)) return false;
      const local = currentDocuments[draft.id];
      return !local || draft.updatedAt > (local.updatedAt || local.createdAt);
    });
    if (!acceptedDrafts.length) return;
    setDocuments((current) => ({
      ...current,
      ...Object.fromEntries(
        acceptedDrafts.map((draft) => [draft.id, storedDraftDocument(draft)]),
      ),
    }));
    setDrafts((current) => ({
      ...current,
      ...Object.fromEntries(
        acceptedDrafts.map((draft) => [draft.id, draft.content]),
      ),
    }));
  }

  function changeDraftContent(document: ViewerDocument, content: string) {
    draftsRef.current = { ...draftsRef.current, [document.id]: content };
    setDrafts(draftsRef.current);
    if (!isUntitledId(document.id)) return;
    setDocuments((current) => ({
      ...current,
      [document.id]: {
        ...current[document.id],
        content,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  async function flushDrafts() {
    if (!persistenceEnabled) return;
    await Promise.all(draftSnapshotRef.current.map(queueDraftSync));
    await Promise.all(Object.values(draftSyncQueues.current));
  }

  useWorkspacePersistence({
    documents,
    drafts,
    documentsRef,
    draftSnapshotRef,
    syncedDrafts,
    queueDraftSync,
    expandedDirectories,
    expandedDirectoriesReady,
    bundleId,
    enabled: persistenceEnabled,
  });

  useEffect(() => {
    if (!persistenceEnabled) return;
    const interval = window.setInterval(() => {
      for (const draft of draftSnapshotRef.current) queueDraftSync(draft);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [bundleId, persistenceEnabled, queueDraftSync]);

  return {
    documents,
    setDocuments,
    loadingDocuments,
    setLoadingDocuments,
    editingKey,
    setEditingKey,
    drafts,
    setDrafts,
    savingDocuments,
    setSavingDocuments,
    deletingDraftIds,
    setDeletingDraftIds,
    deletingNoteId,
    setDeletingNoteId,
    filingQueues,
    setFilingQueues,
    documentRequests,
    deletingDirectories,
    directoryDeletions,
    documentMutationSequence,
    saveQueues,
    draftSyncQueues,
    filingDraftIds,
    draftsRef,
    documentsRef,
    mergeRemoteDrafts,
    changeDraftContent,
    flushDrafts,
  };
}

export type WorkspaceDocumentState = ReturnType<
  typeof useWorkspaceDocumentState
>;
