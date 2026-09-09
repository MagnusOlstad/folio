import type { Dispatch, SetStateAction } from "react";
import type {
  BundleFile,
  Filing,
  FilingConfirmResult,
  Note,
  NoteDetail,
  NoteUpdateResult,
  TabGroup,
  ViewerDocument,
} from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import {
  filedDraftContent,
  isUntitledId,
  toggleTaskAtLine,
} from "../../../lib/workspace.ts";
import type { WorkspaceDocumentState } from "./useWorkspaceDocumentState.ts";
import {
  filingEntry,
  applyStandaloneFilingTabs,
  advanceFilingQueue,
  dismissFailedPreparation,
  finishDraftFiling,
  proposalFields,
  type FilingFields,
} from "../model/filing.ts";

type UseWorkspaceDocumentMutationsOptions = {
  documents: WorkspaceDocumentState;
  setGroups: Dispatch<SetStateAction<TabGroup[]>>;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setFiles: Dispatch<SetStateAction<BundleFile[]>>;
  setMessage: (message: string) => void;
  clearDiscovery: () => void;
  replaceDiscoveryDocument: (oldId: string, updated: NoteDetail) => void;
};

type FiledDraftResult = {
  note: Note;
  notes: Note[];
  warning: string | null;
  appended: boolean;
  // Older archived drafts were filed before confirmation metadata existed.
  filing?: Filing | null;
};

export function useWorkspaceDocumentMutations({
  documents: state,
  setGroups,
  setNotes,
  setFiles,
  setMessage,
  clearDiscovery,
  replaceDiscoveryDocument,
}: UseWorkspaceDocumentMutationsOptions) {
  function updateFilingEntry(
    documentId: string,
    update: (entry: ReturnType<typeof filingEntry>) => ReturnType<typeof filingEntry>,
  ) {
    state.setFilingQueues((current) => {
      const queue = current[documentId];
      if (!queue?.length) return current;
      return { ...current, [documentId]: [update(queue[0]), ...queue.slice(1)] };
    });
  }

  function changeFilingFields(documentId: string, fields: FilingFields) {
    updateFilingEntry(documentId, (entry) => ({ ...entry, fields }));
  }

  function revealStandaloneFiling(documentId: string) {
    updateFilingEntry(documentId, (entry) => {
      if (!entry.filing.standaloneProposal) return entry;
      return {
        ...entry,
        standalone: true,
        fields: proposalFields(entry.filing.standaloneProposal),
        status: "ready",
        error: null,
      };
    });
  }

  function submitFiling(
    groupId: string,
    documentId: string,
    action: "accept" | "standalone",
    fields: FilingFields,
  ) {
    const entry = state.filingQueues[documentId]?.[0];
    if (!entry) return;
    updateFilingEntry(documentId, (current) => ({ ...current, status: "submitting", error: null }));
    void api<FilingConfirmResult>("/api/filing/confirm", {
      method: "POST",
      body: JSON.stringify({ id: entry.filing.id, action, fields }),
    }).then(async (result) => {
      const [detailResult, sourceDetailResult, filesResult] = await Promise.allSettled([
        api<NoteDetail>(`/api/note?id=${encodeURIComponent(result.newId)}`),
        action === "standalone" && !result.sourceRemoved
          ? api<NoteDetail>(`/api/note?id=${encodeURIComponent(documentId)}`)
          : Promise.resolve(null),
        api<BundleFile[]>("/api/files"),
      ]);
      if (action === "standalone") {
        const standalone: ViewerDocument = detailResult.status === "fulfilled"
          ? { ...detailResult.value, deletable: true }
          : {
              ...result.note,
              content: "",
              deletable: true,
              movable: true,
              links: [],
              backlinks: [],
              suggestions: [],
            };
        state.setDocuments((current) => {
          const next = { ...current, [result.newId]: standalone };
          if (result.sourceRemoved) delete next[documentId];
          else if (sourceDetailResult.status === "fulfilled" && sourceDetailResult.value)
            next[documentId] = { ...sourceDetailResult.value, deletable: true };
          return next;
        });
        setGroups((current) => applyStandaloneFilingTabs(
          current,
          groupId,
          documentId,
          result.newId,
          Boolean(result.sourceRemoved),
        ));
        clearDiscovery();
      } else if (detailResult.status === "fulfilled") {
        applyUpdatedNote(detailResult.value, result.oldId);
      } else {
        const updated: ViewerDocument = {
          ...result.note,
          content: state.documentsRef.current[documentId]?.content ?? "",
          deletable: true,
          movable: true,
          links: [],
          backlinks: [],
          suggestions: [],
        };
        state.setDocuments((current) => {
          const next = { ...current, [result.newId]: updated };
          if (result.oldId !== result.newId) delete next[result.oldId];
          return next;
        });
        if (result.oldId !== result.newId) {
          setGroups((current) => current.map((group) => ({
            ...group,
            tabs: group.tabs
              .map((id) => (id === result.oldId ? result.newId : id))
              .filter((id, index, tabs) => tabs.indexOf(id) === index),
            activeId: group.activeId === result.oldId ? result.newId : group.activeId,
          })));
        }
      }
      setNotes(result.notes);
      if (filesResult.status === "fulfilled") setFiles(filesResult.value);
      state.setFilingQueues((current) =>
        advanceFilingQueue(current, documentId, result.newId, action),
      );
      if (result.warning) setMessage(result.warning);
    }).catch((error) => {
      updateFilingEntry(documentId, (current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : "Could not confirm filing.",
      }));
    });
  }

  function confirmFiling(groupId: string, documentId: string, action: "accept" | "standalone") {
    const entry = state.filingQueues[documentId]?.[0];
    if (!entry || entry.status === "preparing" || entry.status === "submitting") return;
    if (entry.filing.id === documentId && isUntitledId(documentId)) {
      const draft = state.documentsRef.current[documentId];
      if (draft) fileDraft(draft);
      return;
    }
    submitFiling(groupId, documentId, action, entry.fields);
  }

  function dismissFiling(groupId: string, documentId: string) {
    const entry = state.filingQueues[documentId]?.[0];
    if (!entry || entry.status === "preparing" || entry.status === "submitting") return;
    if (entry.filing.id === documentId && isUntitledId(documentId)) {
      if (entry.status === "error") {
        state.setFilingQueues((current) => dismissFailedPreparation(current, documentId));
        return;
      }
      const draft = state.documentsRef.current[documentId];
      if (draft) fileDraft(draft);
      return;
    }
    submitFiling(groupId, documentId, "accept", proposalFields(entry.filing.proposal));
  }
  function applyUpdatedNote(updated: NoteDetail, oldId = updated.id) {
    const newId = updated.id;
    state.setDocuments((current) => {
      const next = { ...current };
      const previous = current[oldId] || current[newId];
      if (oldId !== newId) delete next[oldId];
      next[newId] = { ...previous, ...updated, deletable: true };
      return next;
    });
    if (oldId !== newId) {
      setGroups((current) =>
        current.map((group) => {
          const tabs = group.tabs
            .map((id) => (id === oldId ? newId : id))
            .filter((id, index, allTabs) => allTabs.indexOf(id) === index);
          return {
            ...group,
            tabs,
            activeId: group.activeId === oldId ? newId : group.activeId,
          };
        }),
      );
      state.setDrafts((current) => {
        if (!(oldId in current)) return current;
        const next = { ...current };
        delete next[oldId];
        next[newId] = updated.content;
        return next;
      });
      state.setEditingKey((current) =>
        current?.endsWith(`:${oldId}`)
          ? current.slice(0, -oldId.length) + newId
          : current,
      );
      delete state.documentRequests.current[oldId];
    }
    setNotes((current) =>
      current.map((note) =>
        note.id === oldId ? { ...note, ...updated } : note,
      ),
    );
    replaceDiscoveryDocument(oldId, updated);
  }

  function persistMetadata(
    document: ViewerDocument,
    field: "title" | "description",
    value: string,
  ) {
    const normalized = value.trim();
    if (field === "title" && !normalized) {
      setMessage("A note title cannot be empty.");
      return;
    }
    if (normalized === document[field]) return;
    const id = document.id;
    const existingQueue = state.saveQueues.current[id] || Promise.resolve();
    state.setSavingDocuments((current) => new Set(current).add(id));
    const save = existingQueue
      .catch(() => undefined)
      .then(async () => {
        const result = await api<NoteUpdateResult>(
          `/api/note?id=${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ [field]: normalized }),
          },
        );
        const [notesResult, filesResult] = await Promise.allSettled([
          api<Note[]>("/api/notes"),
          api<BundleFile[]>("/api/files"),
        ]);
        applyUpdatedNote(result, result.oldId);
        if (notesResult.status === "fulfilled") setNotes(notesResult.value);
        if (filesResult.status === "fulfilled") setFiles(filesResult.value);
        clearDiscovery();
        if (result.warning) setMessage(result.warning);
      })
      .catch((error) =>
        setMessage(
          error instanceof Error
            ? error.message
            : `Could not update note ${field}`,
        ),
      )
      .finally(() => {
        if (state.saveQueues.current[id] === save) {
          delete state.saveQueues.current[id];
          state.setSavingDocuments((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      });
    state.saveQueues.current[id] = save;
  }

  function persistDocument(
    document: ViewerDocument,
    nextContent: string,
    nextTags: string[],
    propagateError = false,
    refreshEmbeddings = true,
  ) {
    if (!document.deletable || !nextContent.trim()) return Promise.resolve();
    const id = document.id;
    const filedContent = isUntitledId(id)
      ? filedDraftContent(nextContent)
      : nextContent;
    if (!filedContent.trim()) return Promise.resolve();
    const existingQueue = state.saveQueues.current[id] || Promise.resolve();
    state.setDocuments((current) => ({
      ...current,
      [id]: { ...current[id], content: nextContent, tags: nextTags },
    }));
    state.setSavingDocuments((current) => new Set(current).add(id));
    const save = existingQueue
      .catch(() => undefined)
      .then(async () => {
        if (isUntitledId(id)) {
          state.filingDraftIds.current.add(id);
          await (
            state.draftSyncQueues.current[id] || Promise.resolve()
          ).catch(() => undefined);
          const result = await api<FiledDraftResult>("/api/notes", {
            method: "POST",
            body: JSON.stringify({
              content: nextContent,
              filedContent,
              draftId: id,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          });
          const [detailResult, filesResult] = await Promise.allSettled([
            api<NoteDetail>(`/api/note?id=${encodeURIComponent(result.note.id)}`),
            api<BundleFile[]>("/api/files"),
          ]);
          const updated: ViewerDocument =
            detailResult.status === "fulfilled"
              ? { ...detailResult.value, deletable: true }
              : {
                  ...result.note,
                  content: filedContent,
                  deletable: true,
                  movable: true,
                  links: [],
                  backlinks: [],
                  suggestions: [],
                };
          setNotes((current) => [
            result.note,
            ...current.filter((note) => note.id !== result.note.id),
          ]);
          if (filesResult.status === "fulfilled") setFiles(filesResult.value);
          state.setDocuments((current) => {
            const next = { ...current };
            delete next[id];
            next[updated.id] = updated;
            return next;
          });
          state.setDrafts((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          setGroups((current) =>
            current.map((group) => {
              const tabs = group.tabs
                .map((tabId) => (tabId === id ? updated.id : tabId))
                .filter(
                  (tabId, index, allTabs) => allTabs.indexOf(tabId) === index,
                );
              return {
                ...group,
                tabs,
                activeId: group.activeId === id ? updated.id : group.activeId,
              };
            }),
          );
          const refreshWarning =
            detailResult.status === "rejected" ||
            filesResult.status === "rejected"
              ? "The workspace will fully refresh when the file is reopened."
              : "";
          state.setFilingQueues((current) =>
            finishDraftFiling(current, id, updated.id, result.filing),
          );
          if (refreshWarning) setMessage(refreshWarning);
          return;
        }
        const updated = await api<NoteUpdateResult>(
          `/api/note?id=${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              content: nextContent,
              tags: nextTags,
              refreshEmbeddings,
            }),
          },
        );
        applyUpdatedNote(updated, updated.oldId);
        if (updated.warning) setMessage(updated.warning);
      })
      .catch((error) => {
        if (isUntitledId(id)) {
          state.filingDraftIds.current.delete(id);
          updateFilingEntry(id, (entry) => ({
            ...entry,
            status: "error",
            error: error instanceof Error ? error.message : "Could not prepare filing.",
          }));
        }
        setMessage(error instanceof Error ? error.message : "Could not save note");
        if (propagateError) throw error;
      })
      .finally(() => {
        if (state.saveQueues.current[id] === save) {
          delete state.saveQueues.current[id];
          state.setSavingDocuments((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      });
    state.saveQueues.current[id] = save;
    return save;
  }

  async function refreshDocumentEmbedding(id: string) {
    const document = state.documentsRef.current[id];
    if (!document?.deletable || isUntitledId(id)) return false;
    try {
      const updated = await api<NoteUpdateResult>(
        `/api/note?id=${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ refreshEmbeddings: true }),
        },
      );
      applyUpdatedNote(updated, updated.oldId);
      if (updated.warning) setMessage(updated.warning);
      return !updated.warning;
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not refresh note embeddings",
      );
      return false;
    }
  }

  function beginEditing(
    groupId: string,
    document: ViewerDocument,
  ) {
    if (
      !document.deletable ||
      state.deletingNoteId === document.id
    )
      return;
    const key = `${groupId}:${document.id}`;
    state.setDrafts((current) => ({
      ...current,
      [document.id]: current[document.id] ?? document.content,
    }));
    state.setEditingKey(key);
  }

  function finishEditing(
    groupId: string,
    document: ViewerDocument,
    _scrollTop = 0,
  ) {
    const key = `${groupId}:${document.id}`;
    if (state.editingKey !== key) return;
    if (isUntitledId(document.id)) return;
    state.setEditingKey(null);
  }

  function fileDraft(document: ViewerDocument) {
    const content = state.drafts[document.id] ?? document.content;
    if (
      !filedDraftContent(content).trim() ||
      state.savingDocuments.has(document.id)
    )
      return;
    state.filingDraftIds.current.add(document.id);
    state.setEditingKey(null);
    state.setFilingQueues((current) => ({
      ...current,
      [document.id]: [{
        filing: {
          id: document.id,
          draftId: document.id,
          mode: "new",
          destinationId: null,
          actor: "agent",
          proposal: { directory: "", filename: "", title: "", description: "", tags: [] },
        },
        fields: { directory: "", title: "", description: "", tags: [] },
        standalone: false,
        status: "preparing",
        error: null,
      }],
    }));
    persistDocument(document, content, []);
  }

  async function toggleTaskCheckbox(
    document: ViewerDocument,
    lineNumber: number,
    checked: boolean,
  ) {
    const nextContent = toggleTaskAtLine(document.content, lineNumber, checked);
    if (nextContent) persistDocument(document, nextContent, document.tags);
  }

  return {
    persistMetadata,
    persistDocument,
    refreshDocumentEmbedding,
    beginEditing,
    finishEditing,
    fileDraft,
    changeFilingFields,
    revealStandaloneFiling,
    confirmFiling,
    dismissFiling,
    toggleTaskCheckbox,
  };
}
