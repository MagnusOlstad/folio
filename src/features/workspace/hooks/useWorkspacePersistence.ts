import { useEffect } from "react";
import type { StoredDraft, ViewerDocument } from "../../../domain/types.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import { writeStorageItem } from "../../../lib/storage.ts";

export function useWorkspacePersistence({
  documents,
  drafts,
  documentsRef,
  draftSnapshotRef,
  queueDraftSync,
  expandedDirectories,
  expandedDirectoriesReady,
}: {
  documents: Record<string, ViewerDocument>;
  drafts: Record<string, string>;
  documentsRef: React.MutableRefObject<Record<string, ViewerDocument>>;
  draftSnapshotRef: React.MutableRefObject<StoredDraft[]>;
  queueDraftSync: (draft: StoredDraft) => Promise<void>;
  expandedDirectories: Set<string>;
  expandedDirectoriesReady: boolean;
}) {
  // Keep the original synchronization cadence: it follows draft changes, not callback identity.
  useEffect(() => {
    documentsRef.current = documents;
    const localDrafts: StoredDraft[] = Object.values(documents)
      .filter((document) => isUntitledId(document.id))
      .map((document) => ({
        id: document.id,
        content: drafts[document.id] ?? document.content,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt || document.createdAt,
      }));
    const nonemptyDrafts = localDrafts.filter((draft) => draft.content.trim());
    draftSnapshotRef.current = nonemptyDrafts;
    try {
      writeStorageItem("folio:drafts", JSON.stringify(nonemptyDrafts));
    } catch {
      /* server copy remains authoritative */
    }
    const syncTimer = window.setTimeout(() => {
      for (const draft of localDrafts) queueDraftSync(draft);
    }, 450);
    return () => window.clearTimeout(syncTimer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, drafts]);

  useEffect(() => {
    if (!expandedDirectoriesReady) return;
    try {
      writeStorageItem(
        "folio:expanded-directories",
        JSON.stringify([...expandedDirectories]),
      );
    } catch {
      /* optional persistence */
    }
  }, [expandedDirectories, expandedDirectoriesReady]);
}
