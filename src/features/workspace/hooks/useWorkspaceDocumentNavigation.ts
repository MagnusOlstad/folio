import { useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  BundleFile,
  Note,
  NoteDetail,
  TabGroup,
  ViewerDocument,
} from "../../../domain/types.ts";
import { apiForBundle, getActiveBundleId, getActiveBundleRevision } from "../../../lib/api.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import type { WorkspaceDocumentState } from "./useWorkspaceDocumentState.ts";
import {
  activateGroupTab,
  openPreviewTab,
  pinGroupTab,
} from "../model/tab-state.ts";
import { documentPathAfterChanges, replaceDocumentTabs } from "../model/document-path.ts";

type UseWorkspaceDocumentNavigationOptions = {
  documents: WorkspaceDocumentState;
  groups: TabGroup[];
  setGroups: Dispatch<SetStateAction<TabGroup[]>>;
  activeGroupId: string;
  setActiveGroupId: Dispatch<SetStateAction<string>>;
  closeTab: (groupId: string, documentId: string) => void;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setFiles: Dispatch<SetStateAction<BundleFile[]>>;
  setMessage: (message: string) => void;
  removeDiscoveryDocument: (id: string) => void;
};

export function useWorkspaceDocumentNavigation({
  documents: state,
  groups,
  setGroups,
  activeGroupId,
  setActiveGroupId,
  closeTab,
  setNotes,
  setFiles,
  setMessage,
  removeDiscoveryDocument,
}: UseWorkspaceDocumentNavigationOptions) {
  const pendingLoads = useRef(new Map<string, { revision: number; requestId: number }>());

  async function deleteLocalDraft(id: string) {
    if (state.deletingDraftIds.has(id) || state.savingDocuments.has(id)) return;
    state.filingDraftIds.current.add(id);
    state.setDeletingDraftIds((current) => new Set(current).add(id));
    setMessage("");
    const bundleId = getActiveBundleId();
    const revision = getActiveBundleRevision();
    const isCurrent = () => getActiveBundleRevision() === revision;
    try {
      await (state.draftSyncQueues.current[id] || Promise.resolve()).catch(
        () => undefined,
      );
      if (!isCurrent()) return;
      await apiForBundle<{ deletedId: string }>(
        bundleId, `/api/draft?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!isCurrent()) return;
      const nextDocuments = { ...state.documentsRef.current };
      const nextDrafts = { ...state.draftsRef.current };
      delete nextDocuments[id];
      delete nextDrafts[id];
      state.documentsRef.current = nextDocuments;
      state.draftsRef.current = nextDrafts;
      state.setDocuments((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      state.setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setGroups((current) =>
        current.map((group) => {
          const tabIndex = group.tabs.indexOf(id);
          const tabs = group.tabs.filter((tabId) => tabId !== id);
          const activeId =
            group.activeId === id
              ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
              : group.activeId;
          return {
            ...group,
            tabs,
            activeId,
            previewId: group.previewId === id ? null : group.previewId,
          };
        }),
      );
      state.setEditingKey((current) =>
        current?.endsWith(`:${id}`) ? null : current,
      );
    } catch (error) {
      if (!isCurrent()) return;
      state.filingDraftIds.current.delete(id);
      setMessage(
        error instanceof Error ? error.message : "Could not delete draft",
      );
    } finally {
      if (isCurrent()) state.setDeletingDraftIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function deleteFiledNote(document: Pick<ViewerDocument, "id" | "title" | "deletable">, propagateError = false) {
    if (
      !document.deletable ||
      isUntitledId(document.id) ||
      state.deletingNoteId ||
      state.savingDocuments.has(document.id)
    )
      return;
    if ([...state.deletingDirectories.current].some((path) => document.id.startsWith(`${path}/`))) return;
    const bundleId = getActiveBundleId();
    const revision = getActiveBundleRevision();
    const isCurrent = () => getActiveBundleRevision() === revision;
    state.setDeletingNoteId(document.id);
    setMessage("");
    try {
      await (state.saveQueues.current[document.id] || Promise.resolve());
      if (!isCurrent()) return;
      const result = await apiForBundle<{ deletedId: string; rawId: string | null }>(
        bundleId, `/api/note?id=${encodeURIComponent(document.id)}`,
        { method: "DELETE" },
      );
      if (!isCurrent()) return;
      state.recordDocumentPathChange(result.deletedId, null);
      const nextDocuments = { ...state.documentsRef.current };
      const nextDrafts = { ...state.draftsRef.current };
      delete nextDocuments[result.deletedId];
      delete nextDrafts[result.deletedId];
      state.documentsRef.current = nextDocuments;
      state.draftsRef.current = nextDrafts;
      state.setLoadingDocuments((current) => new Set([...current].filter((id) => id !== result.deletedId)));
      const [notesResult, filesResult] = await Promise.allSettled([
        apiForBundle<Note[]>(bundleId, "/api/notes"),
        apiForBundle<BundleFile[]>(bundleId, "/api/files"),
      ]);
      if (!isCurrent()) return;
      setNotes((current) =>
        notesResult.status === "fulfilled"
          ? notesResult.value
          : current.filter((note) => note.id !== result.deletedId),
      );
      setFiles((current) =>
        filesResult.status === "fulfilled"
          ? filesResult.value
          : current.filter((file) => file.id !== result.deletedId),
      );
      state.setDocuments((current) => {
        const next = { ...current };
        delete next[result.deletedId];
        return next;
      });
      state.setDrafts((current) => {
        const next = { ...current };
        delete next[result.deletedId];
        return next;
      });
      setGroups((current) =>
        current.map((group) => {
          const tabIndex = group.tabs.indexOf(result.deletedId);
          const tabs = group.tabs.filter((id) => id !== result.deletedId);
          const activeId =
            group.activeId === result.deletedId
              ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
              : group.activeId;
          return {
            ...group,
            tabs,
            activeId,
            previewId:
              group.previewId === result.deletedId ? null : group.previewId,
          };
        }),
      );
      state.setEditingKey((current) =>
        current?.endsWith(`:${result.deletedId}`) ? null : current,
      );
      removeDiscoveryDocument(result.deletedId);
      setMessage(
        `Deleted ${document.title}.${result.rawId ? " The raw capture was retained." : ""}`,
      );
    } catch (error) {
      if (!isCurrent()) return;
      setMessage(
        error instanceof Error ? error.message : "Could not delete note",
      );
      if (propagateError) throw error;
    } finally {
      if (isCurrent()) state.setDeletingNoteId(null);
    }
  }

  async function openDocument(
    id: string,
    source: "note" | "file" = "file",
    targetGroupId = activeGroupId,
    disposition: "preview" | "permanent" = "permanent",
  ) {
    if ([...state.deletingDirectories.current].some((directory) => id.startsWith(`${directory}/`))) return;
    const existingGroup = groups.find((group) => group.tabs.includes(id));
    const openGroupId = existingGroup?.id ?? targetGroupId;
    setActiveGroupId(openGroupId);
    setGroups((current) => {
      if (existingGroup) {
        const activated = activateGroupTab(current, openGroupId, id);
        return disposition === "permanent"
          ? pinGroupTab(activated, openGroupId, id)
          : activated;
      }
      if (disposition === "preview")
        return openPreviewTab(current, openGroupId, id);
      const opened = current.map((group) =>
        group.id === openGroupId
          ? {
              ...group,
              tabs: group.tabs.includes(id) ? group.tabs : [...group.tabs, id],
              activeId: id,
            }
          : group,
      );
      return pinGroupTab(opened, openGroupId, id);
    });
    if (state.documentsRef.current[id]) return;
    try {
      await loadDocument(id, source);
    } catch (error) {
      closeTab(openGroupId, id);
      setMessage(error instanceof Error ? error.message : "Could not open file");
    }
  }

  async function loadDocument(id: string, source: "note" | "file" = "file") {
    const bundleId = getActiveBundleId();
    const revision = getActiveBundleRevision();
    const pending = pendingLoads.current.get(id);
    if (state.documentsRef.current[id] || (pending?.revision === revision && state.documentRequests.current[id] === pending.requestId)) return;
    const mutationSequence = state.documentMutationSequence.current;
    const requestId = (state.documentRequests.current[id] || 0) + 1;
    state.documentRequests.current[id] = requestId;
    pendingLoads.current.set(id, { revision, requestId });
    state.setLoadingDocuments((current) => new Set(current).add(id));
    try {
      const document =
        source === "note"
          ? {
              ...(await apiForBundle<NoteDetail>(bundleId, `/api/note?id=${encodeURIComponent(id)}`)),
              deletable: true,
            }
          : await apiForBundle<ViewerDocument>(
              bundleId, `/api/file?path=${encodeURIComponent(id)}`,
            );
      if (state.documentRequests.current[id] !== requestId || getActiveBundleRevision() !== revision) return;
      const changedId = documentPathAfterChanges(state.documentPathChanges.current, document.id, mutationSequence);
      if (changedId !== undefined) {
        setGroups((current) => changedId
          ? replaceDocumentTabs(current, id, changedId)
          : current.map((group) => {
              const tabs = group.tabs.filter((tabId) => tabId !== id);
              return { ...group, tabs, activeId: group.activeId === id ? tabs.at(-1) || null : group.activeId, previewId: group.previewId === id ? null : group.previewId };
            }));
        return;
      }
      if (Object.entries(state.directoryDeletions.current).some(([directory, sequence]) =>
        sequence > mutationSequence && document.id.startsWith(`${directory}/`))) {
        setGroups((current) => current.map((group) => {
          const tabs = group.tabs.filter((tabId) => tabId !== id);
          return {
            ...group, tabs,
            activeId: group.activeId === id ? tabs.at(-1) || null : group.activeId,
            previewId: group.previewId === id ? null : group.previewId,
          };
        }));
        return;
      }
      // Another tab may have loaded or edited the canonical path while this
      // alias request was in flight. Its cached document is authoritative.
      if (document.id !== id && state.documentsRef.current[document.id]) {
        setGroups((current) => replaceDocumentTabs(current, id, document.id));
        return;
      }
      state.documentsRef.current = { ...state.documentsRef.current, [document.id]: document };
      state.setDocuments((current) => ({ ...current, [document.id]: document }));
      if (document.id !== id) {
        setGroups((current) => replaceDocumentTabs(current, id, document.id));
      }
    } catch (error) {
      // A failure from an invalidated request must not close a replacement tab
      // or report an error in a different bundle.
      if (state.documentRequests.current[id] === requestId && getActiveBundleRevision() === revision) throw error;
    } finally {
      if (pendingLoads.current.get(id)?.requestId === requestId) pendingLoads.current.delete(id);
      if (state.documentRequests.current[id] === requestId && getActiveBundleRevision() === revision) state.setLoadingDocuments((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  return { deleteLocalDraft, deleteFiledNote, openDocument, loadDocument };
}
