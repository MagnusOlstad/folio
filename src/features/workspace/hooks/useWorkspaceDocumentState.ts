import { useEffect, useRef, useState } from "react";
import type { StoredDraft, ViewerDocument } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import { loadLocalDrafts } from "../../../lib/storage.ts";
import {
  isUntitledId,
  storedDraftDocument,
} from "../../../lib/workspace.ts";
import { useWorkspacePersistence } from "./useWorkspacePersistence.ts";

type UseWorkspaceDocumentStateOptions = {
  expandedDirectories: Set<string>;
  expandedDirectoriesReady: boolean;
};

export function useWorkspaceDocumentState({
  expandedDirectories,
  expandedDirectoriesReady,
}: UseWorkspaceDocumentStateOptions) {
  const [documents, setDocuments] = useState<Record<string, ViewerDocument>>(
    () =>
      Object.fromEntries(
        loadLocalDrafts().map((document) => [document.id, document]),
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
  const [savingDocuments, setSavingDocuments] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingDraftIds, setDeletingDraftIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const documentRequests = useRef<Record<string, number>>({});
  const saveQueues = useRef<Record<string, Promise<void>>>({});
  const draftSyncQueues = useRef<Record<string, Promise<void>>>({});
  const filingDraftIds = useRef<Set<string>>(new Set());
  const documentsRef = useRef(documents);
  const draftSnapshotRef = useRef<StoredDraft[]>([]);

  function queueDraftSync(draft: StoredDraft) {
    if (filingDraftIds.current.has(draft.id)) return Promise.resolve();
    const existingQueue =
      draftSyncQueues.current[draft.id] || Promise.resolve();
    const sync = existingQueue
      .catch(() => undefined)
      .then(async () => {
        if (filingDraftIds.current.has(draft.id)) return;
        await api<StoredDraft>(`/api/draft?id=${encodeURIComponent(draft.id)}`, {
          method: "PUT",
          body: JSON.stringify(draft),
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (draftSyncQueues.current[draft.id] === sync)
          delete draftSyncQueues.current[draft.id];
      });
    draftSyncQueues.current[draft.id] = sync;
    return sync;
  }

  function mergeRemoteDrafts(remoteDrafts: StoredDraft[]) {
    const currentDocuments = documentsRef.current;
    const acceptedDrafts = remoteDrafts.filter((draft) => {
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
    setDrafts((current) => ({ ...current, [document.id]: content }));
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

  useWorkspacePersistence({
    documents,
    drafts,
    documentsRef,
    draftSnapshotRef,
    queueDraftSync,
    expandedDirectories,
    expandedDirectoriesReady,
  });

  useEffect(() => {
    const interval = window.setInterval(() => {
      for (const draft of draftSnapshotRef.current) queueDraftSync(draft);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, []);

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
    documentRequests,
    saveQueues,
    draftSyncQueues,
    filingDraftIds,
    documentsRef,
    mergeRemoteDrafts,
    changeDraftContent,
  };
}

export type WorkspaceDocumentState = ReturnType<
  typeof useWorkspaceDocumentState
>;
