import type { Dispatch, SetStateAction } from "react";
import type {
  BundleFile,
  Note,
  NoteDetail,
  TabGroup,
  ViewerDocument,
} from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import type { WorkspaceDocumentState } from "./useWorkspaceDocumentState.ts";
import {
  activateGroupTab,
  openPreviewTab,
  pinGroupTab,
} from "../model/tab-state.ts";

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
  async function deleteLocalDraft(id: string) {
    if (state.deletingDraftIds.has(id) || state.savingDocuments.has(id)) return;
    state.filingDraftIds.current.add(id);
    state.setDeletingDraftIds((current) => new Set(current).add(id));
    setMessage("");
    try {
      await (state.draftSyncQueues.current[id] || Promise.resolve()).catch(
        () => undefined,
      );
      await api<{ deletedId: string }>(
        `/api/draft?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
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
      state.filingDraftIds.current.delete(id);
      setMessage(
        error instanceof Error ? error.message : "Could not delete draft",
      );
    } finally {
      state.setDeletingDraftIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function deleteFiledNote(document: ViewerDocument) {
    if (
      !document.deletable ||
      isUntitledId(document.id) ||
      state.deletingNoteId ||
      state.savingDocuments.has(document.id)
    )
      return;
    state.setDeletingNoteId(document.id);
    setMessage("");
    try {
      await (state.saveQueues.current[document.id] || Promise.resolve());
      const result = await api<{ deletedId: string; rawId: string | null }>(
        `/api/note?id=${encodeURIComponent(document.id)}`,
        { method: "DELETE" },
      );
      const [notesResult, filesResult] = await Promise.allSettled([
        api<Note[]>("/api/notes"),
        api<BundleFile[]>("/api/files"),
      ]);
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
      delete state.documentRequests.current[result.deletedId];
      setMessage(
        `Deleted ${document.title}.${result.rawId ? " The raw capture was retained." : ""}`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not delete note",
      );
    } finally {
      state.setDeletingNoteId(null);
    }
  }

  async function openDocument(
    id: string,
    source: "note" | "file" = "file",
    targetGroupId = activeGroupId,
    disposition: "preview" | "permanent" = "permanent",
  ) {
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
    if (state.documents[id] || state.loadingDocuments.has(id)) return;
    try {
      await loadDocument(id, source);
    } catch (error) {
      closeTab(openGroupId, id);
      setMessage(error instanceof Error ? error.message : "Could not open file");
    }
  }

  async function loadDocument(id: string, source: "note" | "file" = "file") {
    if (state.documents[id] || state.loadingDocuments.has(id)) return;
    const requestId = (state.documentRequests.current[id] || 0) + 1;
    state.documentRequests.current[id] = requestId;
    state.setLoadingDocuments((current) => new Set(current).add(id));
    try {
      const document =
        source === "note"
          ? {
              ...(await api<NoteDetail>(`/api/note?id=${encodeURIComponent(id)}`)),
              deletable: true,
            }
          : await api<ViewerDocument>(
              `/api/file?path=${encodeURIComponent(id)}`,
            );
      if (state.documentRequests.current[id] !== requestId) return;
      state.setDocuments((current) => ({ ...current, [document.id]: document }));
      if (document.id !== id) {
        setGroups((current) =>
          current.map((group) => ({
            ...group,
            tabs: group.tabs.map((tabId) =>
              tabId === id ? document.id : tabId,
            ),
            activeId: group.activeId === id ? document.id : group.activeId,
            previewId:
              group.previewId === id ? document.id : group.previewId,
          })),
        );
      }
    } finally {
      state.setLoadingDocuments((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  return { deleteLocalDraft, deleteFiledNote, openDocument, loadDocument };
}
