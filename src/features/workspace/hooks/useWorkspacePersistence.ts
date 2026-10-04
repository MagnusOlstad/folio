import { useEffect, useRef } from "react";
import type { StoredDraft, ViewerDocument } from "../../../domain/types.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import { readStorageItem, writeStorageItem } from "../../../lib/storage.ts";

export function useWorkspacePersistence({
  documents,
  drafts,
  documentsRef,
  draftSnapshotRef,
  syncedDrafts,
  queueDraftSync,
  expandedDirectories,
  expandedDirectoriesReady,
  bundleId,
  enabled,
}: {
  documents: Record<string, ViewerDocument>;
  drafts: Record<string, string>;
  documentsRef: React.MutableRefObject<Record<string, ViewerDocument>>;
  draftSnapshotRef: React.MutableRefObject<StoredDraft[]>;
  syncedDrafts: React.MutableRefObject<Map<string, string>>;
  queueDraftSync: (draft: StoredDraft) => Promise<void>;
  expandedDirectories: Set<string>;
  expandedDirectoriesReady: boolean;
  bundleId: string;
  enabled: boolean;
}) {
  const persistedDraftSerialization = useRef<{
    key: string;
    value: string | null;
  } | null>(null);

  // Keep the original synchronization cadence: it follows draft changes, not callback identity.
  useEffect(() => {
    documentsRef.current = documents;
    if (!enabled) {
      draftSnapshotRef.current = [];
      syncedDrafts.current.clear();
      persistedDraftSerialization.current = null;
      return;
    }
    const localDrafts: StoredDraft[] = Object.values(documents)
      .filter((document) => isUntitledId(document.id))
      .map((document) => ({
        id: document.id,
        content: drafts[document.id] ?? document.content,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt || document.createdAt,
      }));
    const relevantSyncKeys = new Set(
      localDrafts.map((draft) => `${bundleId}\u0000${draft.id}`),
    );
    for (const key of syncedDrafts.current.keys()) {
      if (!relevantSyncKeys.has(key)) syncedDrafts.current.delete(key);
    }
    const nonemptyDrafts = localDrafts.filter((draft) => draft.content.trim());
    draftSnapshotRef.current = localDrafts;
    try {
      const storageKey = `folio:drafts:v2:${bundleId}`;
      const serializedDrafts = JSON.stringify(nonemptyDrafts);
      if (persistedDraftSerialization.current?.key !== storageKey) {
        persistedDraftSerialization.current = {
          key: storageKey,
          value: readStorageItem(storageKey),
        };
      }
      if (persistedDraftSerialization.current.value !== serializedDrafts) {
        writeStorageItem(storageKey, serializedDrafts);
        persistedDraftSerialization.current.value = serializedDrafts;
      }
    } catch {
      /* server copy remains authoritative */
    }
    const syncTimer = window.setTimeout(() => {
      for (const draft of localDrafts) queueDraftSync(draft);
    }, 450);
    return () => window.clearTimeout(syncTimer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId, documents, drafts, enabled, syncedDrafts]);

  useEffect(() => {
    if (!enabled || !expandedDirectoriesReady) return;
    try {
      writeStorageItem(
        `folio:expanded-directories:v2:${bundleId}`,
        JSON.stringify([...expandedDirectories]),
      );
    } catch {
      /* optional persistence */
    }
  }, [bundleId, expandedDirectories, expandedDirectoriesReady, enabled]);
}
