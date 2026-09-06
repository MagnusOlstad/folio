import { useEffect, useRef, useState } from "react";
import type {
  AskResult,
  BundleFile,
  EditorIntent,
  ModelStatus,
  Note,
  NoteDetail,
  NoteUpdateResult,
  SearchResult,
  SidebarMode,
  StoredDraft,
  TabGroup,
  VersionInfo,
  ViewerDocument,
} from "../domain/types.ts";
import { api } from "../lib/api.ts";
import {
  conceptUrl,
  directoryForId,
  normalizeDirectoryInput,
  resolveBundleLink,
} from "../lib/paths.ts";
import { buildFileTree } from "../lib/tree.ts";
import { loadExpandedDirectoryState, loadLocalDrafts } from "../lib/storage.ts";
import {
  filedDraftContent,
  formatDate,
  hasInstalledModel,
  isUntitledId,
  parseTags,
  sourcePosition,
  storedDraftDocument,
  toggleTaskAtLine,
} from "../lib/workspace.ts";
import { TopBar } from "../features/status/TopBar.tsx";
import { WorkspaceSidebar } from "../features/sidebar/WorkspaceSidebar.tsx";
import { EditorWorkspace } from "../features/workspace/EditorWorkspace.tsx";
import { useWorkspacePersistence } from "../hooks/useWorkspacePersistence.ts";
import { useWorkspaceBootstrap } from "../hooks/useWorkspaceBootstrap.ts";
import {
  useWorkspaceCommands,
  type WorkspaceShortcutAction,
} from "../hooks/useWorkspaceCommands.ts";
import { useWorkspaceLayout } from "../hooks/useWorkspaceLayout.ts";
import { useWorkspaceBundleActions } from "../hooks/useWorkspaceBundleActions.ts";

declare global {
  interface Window {
    folio?: {
      onMenuAction?: (handler: (action: string) => void) => () => void;
      closeWindow?: () => void;
    };
  }
}

function draftTitle(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 48) : "Untitled";
}

/** Stateful workspace controller composed by the intentionally tiny App shell. */
export function WorkspaceController() {
  const [initialExpandedDirectoryState] = useState(loadExpandedDirectoryState);
  const [documents, setDocuments] = useState<Record<string, ViewerDocument>>(
    () =>
      Object.fromEntries(
        loadLocalDrafts().map((document) => [document.id, document]),
      ),
  );
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("explore");
  const [notes, setNotes] = useState<Note[]>([]);
  const [files, setFiles] = useState<BundleFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    initialExpandedDirectoryState.directories,
  );
  const [expandedDirectoriesReady, setExpandedDirectoriesReady] = useState(
    initialExpandedDirectoryState.restored,
  );
  const [loadingDocuments, setLoadingDocuments] = useState<Set<string>>(
    () => new Set(),
  );
  const [groups, setGroups] = useState<TabGroup[]>([
    { id: "primary", tabs: [], activeId: null },
  ]);
  const {
    sidebarWidth,
    setSidebarWidth,
    splitPosition,
    setSplitPosition,
    beginHorizontalResize,
    finishHorizontalResize,
    resizeSidebar,
    resizeSplit,
  } = useWorkspaceLayout();
  const [activeGroupId, setActiveGroupId] = useState("primary");
  const [draggedTab, setDraggedTab] = useState<{
    documentId: string;
    groupId: string;
  } | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const [dropDirectoryPath, setDropDirectoryPath] = useState<string | null>(
    null,
  );
  const [movingFileId, setMovingFileId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.values(documents)
        .filter((document) => isUntitledId(document.id))
        .map((document) => [document.id, document.content]),
    ),
  );
  const [pathDrafts, setPathDrafts] = useState<Record<string, string>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [metadataDrafts, setMetadataDrafts] = useState<Record<string, string>>(
    {},
  );
  const [editingMetadataKey, setEditingMetadataKey] = useState<string | null>(
    null,
  );
  const [savingDocuments, setSavingDocuments] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingDraftIds, setDeletingDraftIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [askModel, setAskModel] = useState("");
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [message, setMessage] = useState("");
  const [reindexing, setReindexing] = useState(false);
  const [togglingService, setTogglingService] = useState<string | null>(null);
  const [installingModels, setInstallingModels] = useState(false);
  const searchRequest = useRef(0);
  const documentRequests = useRef<Record<string, number>>({});
  const saveQueues = useRef<Record<string, Promise<void>>>({});
  const draftSyncQueues = useRef<Record<string, Promise<void>>>({});
  const filingDraftIds = useRef<Set<string>>(new Set());
  const expandedDirectoriesReadyRef = useRef(
    initialExpandedDirectoryState.restored,
  );
  const editorIntents = useRef<Record<string, EditorIntent>>({});
  const readerScrollPositions = useRef<Record<string, number>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);
  const runShortcutRef = useRef<
    ((action: WorkspaceShortcutAction) => void) | null
  >(null);
  const documentsRef = useRef(documents);
  const draftSnapshotRef = useRef<StoredDraft[]>([]);
  const untitledCounter = useRef(0);

  function queueDraftSync(draft: StoredDraft) {
    if (filingDraftIds.current.has(draft.id)) return Promise.resolve();
    const existingQueue =
      draftSyncQueues.current[draft.id] || Promise.resolve();
    const sync = existingQueue
      .catch(() => undefined)
      .then(async () => {
        if (filingDraftIds.current.has(draft.id)) return;
        await api<StoredDraft>(
          `/api/draft?id=${encodeURIComponent(draft.id)}`,
          {
            method: "PUT",
            body: JSON.stringify(draft),
          },
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (draftSyncQueues.current[draft.id] === sync)
          delete draftSyncQueues.current[draft.id];
      });
    draftSyncQueues.current[draft.id] = sync;
    return sync;
  }

  useWorkspaceBootstrap({
    setStatus,
    setFilesLoading,
    setMessage,
    setNotes,
    setFiles,
    setVersionInfo,
    mergeRemoteDrafts,
    expandedDirectoriesReadyRef,
    setExpandedDirectories,
    setExpandedDirectoriesReady,
  });

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
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 3_000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      for (const draft of draftSnapshotRef.current) queueDraftSync(draft);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, []);

  function saveActiveDocument() {
    const group = groups.find((candidate) => candidate.id === activeGroupId);
    const documentId = group?.activeId;
    if (!documentId) return;
    const activeDocument = documents[documentId];
    if (!activeDocument) return;
    if (isUntitledId(documentId)) {
      fileDraft(activeDocument);
      return;
    }
    if (editingKey !== `${group.id}:${documentId}`) return;
    const content = drafts[documentId] ?? activeDocument.content;
    if (content !== activeDocument.content)
      persistDocument(activeDocument, content, activeDocument.tags);
  }

  function runShortcut(action: WorkspaceShortcutAction) {
    if (action === "new-note") {
      createNewTab();
      return;
    }
    if (action === "close-tab") {
      const group = groups.find((candidate) => candidate.id === activeGroupId);
      if (group?.activeId) closeTab(group.id, group.activeId);
      else window.folio?.closeWindow?.();
      return;
    }
    if (action === "save") {
      saveActiveDocument();
      return;
    }
    if (action === "search") {
      focusSearchInput();
      return;
    }
    const target = document.activeElement;
    if (
      target instanceof HTMLTextAreaElement &&
      target.classList.contains("document-editor")
    ) {
      target.dispatchEvent(
        new CustomEvent("folio-format", { detail: action, cancelable: true }),
      );
    }
  }

  const { focusSearchInput } = useWorkspaceCommands({
    sidebarMode,
    setSidebarMode,
    searchInputRef,
    runShortcutRef,
    runShortcut,
  });

  function titleForId(id: string) {
    if (isUntitledId(id))
      return draftTitle(drafts[id] ?? documents[id]?.content ?? "");
    return (
      documents[id]?.title ||
      notes.find((note) => note.id === id)?.title ||
      files.find((file) => file.id === id)?.name.replace(/\.md$/i, "") ||
      id.split("/").at(-1)?.replace(/\.md$/i, "") ||
      id
    );
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

  function activateTab(groupId: string, documentId: string) {
    setActiveGroupId(groupId);
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId ? { ...group, activeId: documentId } : group,
      ),
    );
    if (isUntitledId(documentId)) setEditingKey(`${groupId}:${documentId}`);
  }

  function createNewTab(targetGroupId = activeGroupId) {
    const id = `untitled:${Date.now()}:${++untitledCounter.current}`;
    const createdAt = new Date().toISOString();
    const document: ViewerDocument = {
      id,
      title: "Untitled",
      type: "Local draft",
      description: "",
      tags: [],
      createdAt,
      content: "",
      deletable: true,
      movable: false,
      status: "draft",
      staleAfter: null,
      stale: false,
      filedBy: null,
      filedAt: null,
      links: [],
      backlinks: [],
      suggestions: [],
      updatedAt: createdAt,
    };
    setDocuments((current) => ({ ...current, [id]: document }));
    setDrafts((current) => ({ ...current, [id]: "" }));
    setGroups((current) =>
      current.map((group) =>
        group.id === targetGroupId
          ? { ...group, tabs: [...group.tabs, id], activeId: id }
          : group,
      ),
    );
    setActiveGroupId(targetGroupId);
    setEditingKey(`${targetGroupId}:${id}`);
  }

  function openLocalDraft(id: string, targetGroupId = activeGroupId) {
    const existingGroup = groups.find((group) => group.tabs.includes(id));
    if (existingGroup) {
      activateTab(existingGroup.id, id);
      setEditingKey(`${existingGroup.id}:${id}`);
      return;
    }
    setGroups((current) =>
      current.map((group) =>
        group.id === targetGroupId
          ? { ...group, tabs: [...group.tabs, id], activeId: id }
          : group,
      ),
    );
    setActiveGroupId(targetGroupId);
    setEditingKey(`${targetGroupId}:${id}`);
  }

  async function deleteLocalDraft(id: string) {
    if (deletingDraftIds.has(id) || savingDocuments.has(id)) return;
    filingDraftIds.current.add(id);
    setDeletingDraftIds((current) => new Set(current).add(id));
    setMessage("");
    try {
      await (draftSyncQueues.current[id] || Promise.resolve()).catch(
        () => undefined,
      );
      await api<{ deletedId: string }>(
        `/api/draft?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setDocuments((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setDrafts((current) => {
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
          return { ...group, tabs, activeId };
        }),
      );
      setEditingKey((current) =>
        current?.endsWith(`:${id}`) ? null : current,
      );
    } catch (error) {
      filingDraftIds.current.delete(id);
      setMessage(
        error instanceof Error ? error.message : "Could not delete draft",
      );
    } finally {
      setDeletingDraftIds((current) => {
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
      deletingNoteId ||
      savingDocuments.has(document.id)
    )
      return;
    if (
      !window.confirm(
        `Delete "${document.title}"? The raw capture will be retained.`,
      )
    )
      return;

    setDeletingNoteId(document.id);
    setMessage("");
    try {
      await (saveQueues.current[document.id] || Promise.resolve());
      const result = await api<{ deletedId: string; rawId: string | null }>(
        `/api/note?id=${encodeURIComponent(document.id)}`,
        {
          method: "DELETE",
        },
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
      setDocuments((current) => {
        const next = { ...current };
        delete next[result.deletedId];
        return next;
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[result.deletedId];
        return next;
      });
      setPathDrafts((current) => {
        const next = { ...current };
        delete next[result.deletedId];
        return next;
      });
      setTagDrafts((current) => {
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
          return { ...group, tabs, activeId };
        }),
      );
      setEditingKey((current) =>
        current?.endsWith(`:${result.deletedId}`) ? null : current,
      );
      setSearchResults((current) =>
        current.filter((note) => note.id !== result.deletedId),
      );
      setAnswer(null);
      delete documentRequests.current[result.deletedId];
      for (const key of Object.keys(editorIntents.current)) {
        if (key.endsWith(`:${result.deletedId}`))
          delete editorIntents.current[key];
      }
      for (const key of Object.keys(readerScrollPositions.current)) {
        if (key.endsWith(`:${result.deletedId}`))
          delete readerScrollPositions.current[key];
      }
      setMessage(
        `Deleted ${document.title}.${result.rawId ? " The raw capture was retained." : ""}`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not delete note",
      );
    } finally {
      setDeletingNoteId(null);
    }
  }

  async function openDocument(
    id: string,
    source: "note" | "file" = "file",
    targetGroupId = activeGroupId,
  ) {
    const existingGroup = groups.find((group) => group.tabs.includes(id));
    if (existingGroup && existingGroup.id !== targetGroupId) {
      activateTab(existingGroup.id, id);
      return;
    }

    setActiveGroupId(targetGroupId);
    setGroups((current) =>
      current.map((group) =>
        group.id === targetGroupId
          ? {
              ...group,
              tabs: group.tabs.includes(id) ? group.tabs : [...group.tabs, id],
              activeId: id,
            }
          : group,
      ),
    );

    if (documents[id] || loadingDocuments.has(id)) return;
    const requestId = (documentRequests.current[id] || 0) + 1;
    documentRequests.current[id] = requestId;
    setLoadingDocuments((current) => new Set(current).add(id));
    try {
      const document =
        source === "note"
          ? {
              ...(await api<NoteDetail>(
                `/api/note?id=${encodeURIComponent(id)}`,
              )),
              deletable: true,
            }
          : await api<ViewerDocument>(
              `/api/file?path=${encodeURIComponent(id)}`,
            );
      if (documentRequests.current[id] !== requestId) return;
      setDocuments((current) => ({ ...current, [document.id]: document }));
      if (document.id !== id) {
        setGroups((current) =>
          current.map((group) => ({
            ...group,
            tabs: group.tabs.map((tabId) =>
              tabId === id ? document.id : tabId,
            ),
            activeId: group.activeId === id ? document.id : group.activeId,
          })),
        );
      }
    } catch (error) {
      closeTab(targetGroupId, id);
      setMessage(
        error instanceof Error ? error.message : "Could not open file",
      );
    } finally {
      setLoadingDocuments((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  function closeTab(groupId: string, documentId: string) {
    setGroups((current) =>
      current.map((group) => {
        if (group.id !== groupId) return group;
        const tabIndex = group.tabs.indexOf(documentId);
        const tabs = group.tabs.filter((id) => id !== documentId);
        const activeId =
          group.activeId === documentId
            ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
            : group.activeId;
        return { ...group, tabs, activeId };
      }),
    );
    setEditingKey((current) =>
      current === `${groupId}:${documentId}` ? null : current,
    );
  }

  function splitWorkspace() {
    if (groups.length === 2) return;
    const source =
      groups.find((group) => group.id === activeGroupId) || groups[0];
    const newGroupId = source.id === "primary" ? "secondary" : "primary";
    setGroups((current) => [
      ...current,
      { id: newGroupId, tabs: [], activeId: null },
    ]);
    setActiveGroupId(newGroupId);
  }

  function closeGroup(groupId: string) {
    if (groups.length === 1) return;
    const closing = groups.find((group) => group.id === groupId);
    const remaining = groups.find((group) => group.id !== groupId);
    if (!closing || !remaining) return;
    const tabs = [
      ...remaining.tabs,
      ...closing.tabs.filter((id) => !remaining.tabs.includes(id)),
    ];
    setGroups([
      {
        ...remaining,
        tabs,
        activeId: remaining.activeId || closing.activeId || tabs[0] || null,
      },
    ]);
    setActiveGroupId(remaining.id);
    setEditingKey(null);
  }

  function moveTabToGroup(
    documentId: string,
    sourceGroupId: string,
    targetGroupId: string,
  ) {
    if (sourceGroupId === targetGroupId) return;
    setGroups((current) =>
      current.map((group) => {
        if (group.id === sourceGroupId) {
          const tabIndex = group.tabs.indexOf(documentId);
          const tabs = group.tabs.filter((id) => id !== documentId);
          return {
            ...group,
            tabs,
            activeId:
              group.activeId === documentId
                ? tabs[Math.min(tabIndex, tabs.length - 1)] || null
                : group.activeId,
          };
        }
        if (group.id === targetGroupId) {
          return {
            ...group,
            tabs: group.tabs.includes(documentId)
              ? group.tabs
              : [...group.tabs, documentId],
            activeId: documentId,
          };
        }
        return group;
      }),
    );
    setActiveGroupId(targetGroupId);
    setEditingKey(null);
  }

  function applyUpdatedNote(updated: NoteDetail, oldId = updated.id) {
    const newId = updated.id;
    setDocuments((current) => {
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
      setDrafts((current) => {
        if (!(oldId in current)) return current;
        const next = { ...current };
        delete next[oldId];
        next[newId] = updated.content;
        return next;
      });
      setPathDrafts((current) => {
        if (!(oldId in current)) return current;
        const next = { ...current };
        delete next[oldId];
        return next;
      });
      setTagDrafts((current) => {
        if (!(oldId in current)) return current;
        const next = { ...current };
        delete next[oldId];
        next[newId] = updated.tags.join(", ");
        return next;
      });
      setEditingKey((current) =>
        current?.endsWith(`:${oldId}`)
          ? current.slice(0, -oldId.length) + newId
          : current,
      );
      delete documentRequests.current[oldId];
      for (const positions of [
        editorIntents.current,
        readerScrollPositions.current,
      ]) {
        for (const key of Object.keys(positions)) {
          if (!key.endsWith(`:${oldId}`)) continue;
          positions[`${key.slice(0, -oldId.length)}${newId}`] = positions[key];
          delete positions[key];
        }
      }
    }
    setNotes((current) =>
      current.map((note) =>
        note.id === oldId ? { ...note, ...updated } : note,
      ),
    );
    setSearchResults((current) =>
      current.map((note) =>
        note.id === oldId
          ? {
              ...note,
              ...updated,
              snippet: updated.content
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 320),
            }
          : note,
      ),
    );
    setAnswer((current) =>
      current
        ? {
            ...current,
            sources: current.sources.map((note) =>
              note.id === oldId ? { ...note, ...updated } : note,
            ),
          }
        : null,
    );
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
    const existingQueue = saveQueues.current[id] || Promise.resolve();
    setSavingDocuments((current) => new Set(current).add(id));
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
        setSearchResults([]);
        setAnswer(null);
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
        if (saveQueues.current[id] === save) {
          delete saveQueues.current[id];
          setSavingDocuments((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      });
    saveQueues.current[id] = save;
  }

  function beginMetadataEditing(
    groupId: string,
    document: ViewerDocument,
    field: "title" | "description",
  ) {
    if (
      !document.deletable ||
      savingDocuments.has(document.id) ||
      (field === "title" && !document.movable)
    )
      return;
    const key = `${groupId}:${document.id}:${field}`;
    setMetadataDrafts((current) => ({ ...current, [key]: document[field] }));
    setEditingMetadataKey(key);
  }

  function finishMetadataEditing(
    key: string,
    document: ViewerDocument,
    field: "title" | "description",
    value: string,
  ) {
    setEditingMetadataKey((current) => (current === key ? null : current));
    setMetadataDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    persistMetadata(document, field, value);
  }

  function persistDocument(
    document: ViewerDocument,
    nextContent: string,
    nextTags: string[],
  ) {
    if (!document.deletable || !nextContent.trim()) return;
    const id = document.id;
    const filedContent = isUntitledId(id)
      ? filedDraftContent(nextContent)
      : nextContent;
    if (!filedContent.trim()) return;
    const existingQueue = saveQueues.current[id] || Promise.resolve();
    setDocuments((current) => ({
      ...current,
      [id]: { ...current[id], content: nextContent, tags: nextTags },
    }));
    setSavingDocuments((current) => new Set(current).add(id));

    const save = existingQueue
      .catch(() => undefined)
      .then(async () => {
        if (isUntitledId(id)) {
          filingDraftIds.current.add(id);
          await (draftSyncQueues.current[id] || Promise.resolve()).catch(
            () => undefined,
          );
          const result = await api<{
            note: Note;
            notes: Note[];
            warning: string | null;
            appended: boolean;
          }>("/api/notes", {
            method: "POST",
            body: JSON.stringify({
              content: nextContent,
              filedContent,
              draftId: id,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          });
          const [detailResult, filesResult] = await Promise.allSettled([
            api<NoteDetail>(
              `/api/note?id=${encodeURIComponent(result.note.id)}`,
            ),
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
          setDocuments((current) => {
            const next = { ...current };
            delete next[id];
            next[updated.id] = updated;
            return next;
          });
          setDrafts((current) => {
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
          setMessage(
            [
              result.warning ||
                (result.appended
                  ? "Filed and appended to the existing concept."
                  : "Filed as a new concept."),
              refreshWarning,
            ]
              .filter(Boolean)
              .join(" "),
          );
          return;
        }
        const updated = await api<NoteUpdateResult>(
          `/api/note?id=${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ content: nextContent, tags: nextTags }),
          },
        );
        applyUpdatedNote(updated, updated.oldId);
        if (updated.warning) setMessage(updated.warning);
      })
      .catch((error) => {
        if (isUntitledId(id)) filingDraftIds.current.delete(id);
        setMessage(
          error instanceof Error ? error.message : "Could not save note",
        );
      })
      .finally(() => {
        if (saveQueues.current[id] === save) {
          delete saveQueues.current[id];
          setSavingDocuments((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      });
    saveQueues.current[id] = save;
  }

  function beginEditing(
    groupId: string,
    document: ViewerDocument,
    intent?: EditorIntent,
  ) {
    if (
      !document.deletable ||
      savingDocuments.has(document.id) ||
      deletingNoteId === document.id
    )
      return;
    const key = `${groupId}:${document.id}`;
    if (intent) editorIntents.current[key] = intent;
    setDrafts((current) => ({ ...current, [document.id]: document.content }));
    setEditingKey(key);
  }

  function finishEditing(
    groupId: string,
    document: ViewerDocument,
    scrollTop = 0,
  ) {
    const key = `${groupId}:${document.id}`;
    if (editingKey !== key) return;
    const content = drafts[document.id] ?? document.content;
    if (isUntitledId(document.id)) return;
    readerScrollPositions.current[key] = scrollTop;
    setEditingKey(null);
    if (content !== document.content)
      persistDocument(document, content, document.tags);
  }

  function fileDraft(document: ViewerDocument) {
    const content = drafts[document.id] ?? document.content;
    if (!filedDraftContent(content).trim() || savingDocuments.has(document.id))
      return;
    filingDraftIds.current.add(document.id);
    setEditingKey(null);
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

  async function searchNotes(query = searchQuery, tag = selectedTag) {
    if (!query.trim() && !tag) return;
    const requestId = ++searchRequest.current;
    setSearching(true);
    setMessage("");
    try {
      const parameters = new URLSearchParams();
      if (query.trim()) parameters.set("q", query.trim());
      if (tag) parameters.set("tag", tag);
      const results = await api<SearchResult[]>(`/api/search?${parameters}`);
      if (requestId === searchRequest.current) setSearchResults(results);
    } catch (error) {
      if (requestId === searchRequest.current)
        setMessage(
          error instanceof Error ? error.message : "Could not search notes",
        );
    } finally {
      if (requestId === searchRequest.current) setSearching(false);
    }
  }

  function searchTag(tag: string) {
    setSidebarMode("search");
    setSelectedTag(tag);
    setSearchQuery("");
    void searchNotes("", tag);
  }

  async function askNotes() {
    if (!question.trim() || asking) return;
    const selectedModel = status?.answerModels.includes(askModel)
      ? askModel
      : status?.answerModel;
    if (!selectedModel) return;
    setAsking(true);
    setMessage("");
    setAnswer(null);
    try {
      setAnswer(
        await api<AskResult>("/api/ask", {
          method: "POST",
          body: JSON.stringify({
            question,
            model: selectedModel,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        }),
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not ask your notes",
      );
    } finally {
      setAsking(false);
    }
  }

  const { reindexBundle, moveBundleFile } = useWorkspaceBundleActions(
    { reindexing, groups, files, editingKey, movingFileId, savingDocuments, loadingDocuments },
    { setReindexing, setMessage, setNotes, setFiles, setDocuments, setGroups, setEditingKey, setSearchResults, setAnswer, setMovingFileId, setDrafts, setTagDrafts, setPathDrafts, setExpandedDirectories, setDraggedFileId, setDropDirectoryPath },
  );

  async function toggleOllamaService(service: string, model?: string) {
    if (togglingService) return;
    setTogglingService(service);
    setMessage("");
    try {
      setStatus(
        await api<ModelStatus>(`/api/ollama/toggle/${service}`, {
          method: "POST",
          body: JSON.stringify({ model }),
        }),
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not toggle Ollama service",
      );
    } finally {
      setTogglingService(null);
    }
  }

  async function installOllamaModels() {
    if (installingModels) return;
    setInstallingModels(true);
    setMessage("");
    try {
      setStatus(
        await api<ModelStatus>("/api/ollama/install", { method: "POST" }),
      );
      setMessage("Ollama models installed and ready.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not install Ollama models",
      );
    } finally {
      setInstallingModels(false);
    }
  }

  const fileTree = buildFileTree(files);
  const blockedFileIds = new Set([...savingDocuments, ...loadingDocuments]);
  for (const group of groups) {
    if (editingKey?.startsWith(`${group.id}:`))
      blockedFileIds.add(editingKey.slice(group.id.length + 1));
  }
  const localDraftDocuments = Object.values(documents)
    .filter((document) => isUntitledId(document.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const availableTags = Array.from(
    new Set(notes.flatMap((note) => note.tags)),
  ).sort((left, right) => left.localeCompare(right));
  const configuredAnswerModels = status?.answerModels || [];
  const missingModels = status?.missingModels || [];
  const modelInstallInProgress =
    installingModels || Boolean(status?.installingModels.length);
  const selectedAnswerModel = status?.answerModels.includes(askModel)
    ? askModel
    : status?.answerModel || "";
  const selectedAnswerModelMissing = Boolean(
    status?.online &&
      selectedAnswerModel &&
      !hasInstalledModel(selectedAnswerModel, status.installed),
  );
  const modelEndpoints = [
    { id: "capture", label: "Capture", model: status?.classifierModel },
    { id: "search", label: "Search", model: status?.embedModel },
    { id: "ask", label: "Ask", model: selectedAnswerModel },
  ].map((endpoint) => ({
    ...endpoint,
    state: !status
      ? "checking"
      : !status.online
        ? "offline"
        : !endpoint.model ||
            !hasInstalledModel(endpoint.model, status.installed)
          ? "missing"
          : hasInstalledModel(endpoint.model, status.running)
            ? "online"
            : "stopped",
  }));

  return (
    <main className="shell">
      <TopBar
        versionInfo={versionInfo}
        status={status}
        missingModels={missingModels}
        modelInstallInProgress={modelInstallInProgress}
        modelEndpoints={modelEndpoints}
        togglingService={togglingService}
        onInstall={installOllamaModels}
        onToggle={toggleOllamaService}
      />

      <section
        className="workspace"
        id="workspace"
        style={
          sidebarWidth === null
            ? undefined
            : ({
                "--sidebar-width": `${sidebarWidth}px`,
              } as React.CSSProperties)
        }
      >
        <WorkspaceSidebar
          sidebarMode={sidebarMode}
          setSidebarMode={setSidebarMode}
          reindexing={reindexing}
          reindexBundle={reindexBundle}
          filesLoading={filesLoading}
          localDraftDocuments={localDraftDocuments}
          drafts={drafts}
          draftTitle={draftTitle}
          openLocalDraft={openLocalDraft}
          deleteLocalDraft={deleteLocalDraft}
          deletingDraftIds={deletingDraftIds}
          savingDocuments={savingDocuments}
          fileTree={fileTree}
          expandedDirectories={expandedDirectories}
          draggedFileId={draggedFileId}
          dropDirectoryPath={dropDirectoryPath}
          movingFileId={movingFileId}
          blockedFileIds={blockedFileIds}
          setExpandedDirectories={setExpandedDirectories}
          openDocument={openDocument}
          setDraggedFileId={setDraggedFileId}
          setDropDirectoryPath={setDropDirectoryPath}
          moveBundleFile={moveBundleFile}
          status={status}
          notes={notes}
          searchInputRef={searchInputRef}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          selectedTag={selectedTag}
          searching={searching}
          searchNotes={searchNotes}
          availableTags={availableTags}
          setSelectedTag={setSelectedTag}
          setSearchResults={setSearchResults}
          searchTag={searchTag}
          searchResults={searchResults}
          selectedAnswerModel={selectedAnswerModel}
          setAskModel={setAskModel}
          setAnswer={setAnswer}
          asking={asking}
          configuredAnswerModels={configuredAnswerModels}
          hasInstalledModel={hasInstalledModel}
          question={question}
          setQuestion={setQuestion}
          selectedAnswerModelMissing={selectedAnswerModelMissing}
          askNotes={askNotes}
          answer={answer}
          conceptUrl={conceptUrl}
          formatDate={formatDate}
        />

        <div
          className="horizontal-resize-handle sidebar-resize-handle"
          role="separator"
          tabIndex={0}
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={520}
          aria-valuenow={sidebarWidth ?? undefined}
          onPointerDown={beginHorizontalResize}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              resizeSidebar(event.clientX, event.currentTarget);
          }}
          onPointerUp={finishHorizontalResize}
          onPointerCancel={finishHorizontalResize}
          onDoubleClick={() => setSidebarWidth(null)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const currentWidth =
              sidebarWidth ||
              event.currentTarget.previousElementSibling?.getBoundingClientRect()
                .width ||
              310;
            const workspaceLeft =
              event.currentTarget.parentElement?.getBoundingClientRect().left ||
              0;
            resizeSidebar(
              workspaceLeft +
                currentWidth +
                (event.key === "ArrowLeft" ? -16 : 16),
              event.currentTarget,
            );
          }}
        />

        <EditorWorkspace
          {...{
            groups,
            splitPosition,
            beginHorizontalResize,
            resizeSplit,
            finishHorizontalResize,
            setSplitPosition,
            activeGroupId,
            dropGroupId,
            draggedTab,
            setActiveGroupId,
            setDropGroupId,
            moveTabToGroup,
            setDraggedTab,
            savingDocuments,
            titleForId,
            isUntitledId,
            activateTab,
            createNewTab,
            splitWorkspace,
            closeGroup,
            documents,
            loadingDocuments,
            editingKey,
            editorIntents,
            metadataDrafts,
            setMetadataDrafts,
            finishMetadataEditing,
            beginMetadataEditing,
            drafts,
            setDrafts,
            setDocuments,
            fileDraft,
            finishEditing,
            readerScrollPositions,
            openDocument,
            resolveBundleLink,
            conceptUrl,
            sourcePosition,
            formatDate,
            deleteFiledNote,
            deletingNoteId,
            pathDrafts,
            setPathDrafts,
            tagDrafts,
            setTagDrafts,
            persistDocument,
            editingMetadataKey,
            setEditingMetadataKey,
            message,
            setMessage,
            closeTab,
            beginEditing,
            toggleTaskCheckbox,
            directoryForId,
            normalizeDirectoryInput,
            movingFileId,
            moveBundleFile,
            parseTags,
            filedDraftContent,
          }}
        />
      </section>
    </main>
  );
}
