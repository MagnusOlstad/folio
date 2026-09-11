import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleFile, Note } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import type { WorkspaceShellProps } from "../components/WorkspaceShell.tsx";
import { useWorkspaceBootstrap } from "./useWorkspaceBootstrap.ts";
import { useWorkspaceLayout } from "./useWorkspaceLayout.ts";
import { useWorkspaceModels } from "./useWorkspaceModels.ts";
import { useWorkspaceTabs } from "./useWorkspaceTabs.ts";
import { useWorkspaceDocumentState } from "./useWorkspaceDocumentState.ts";
import { useWorkspaceDocumentMutations } from "./useWorkspaceDocumentMutations.ts";
import { useWorkspaceDocumentNavigation } from "./useWorkspaceDocumentNavigation.ts";
import { useWorkspaceExplorerState } from "./useWorkspaceExplorerState.ts";
import { useWorkspaceSidebarProps } from "./useWorkspaceSidebarProps.ts";
import { useWorkspaceShortcutActions } from "./useWorkspaceShortcutActions.ts";
import { useFiledDocumentAutosave } from "./useFiledDocumentAutosave.ts";
import { expandedPathsForFiles, isUntitledId } from "../../../lib/workspace.ts";
import { bundleDirectories } from "../model/directory-suggestions.ts";
import { useNoteExport } from "./useNoteExport.ts";
import { useThemeSettings } from "../../settings/hooks/useThemeSettings.ts";
import { useObsidianImport } from "../../settings/hooks/useObsidianImport.ts";
import {
  loadWorkspaceSessionState,
  saveWorkspaceSessionState,
  type WorkspaceSessionState,
} from "../model/workspace-state.ts";

function draftTitle(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 48) : "Untitled";
}

export function useWorkspaceController(): WorkspaceShellProps {
  const [message, setMessage] = useState("");
  const [initialWorkspaceState] = useState<WorkspaceSessionState | null>(
    loadWorkspaceSessionState,
  );
  const [workspaceDataReady, setWorkspaceDataReady] = useState(
    initialWorkspaceState === null,
  );
  const [workspaceRestored, setWorkspaceRestored] = useState(
    initialWorkspaceState === null,
  );
  const documentScrollTopsRef = useRef<Record<string, number>>(
    initialWorkspaceState?.documentScrollTops ?? {},
  );
  const explorerScrollTopRef = useRef(
    initialWorkspaceState?.explorerScrollTop ?? 0,
  );
  const latestWorkspaceStateRef = useRef<{
    groups: import("../../../domain/types.ts").TabGroup[];
    activeGroupId: string;
    sidebarMode: import("../../../domain/types.ts").SidebarMode;
  } | null>(null);
  const persistScrollFrameRef = useRef<number | null>(null);
  const restoreStartedRef = useRef(false);
  const noteExport = useNoteExport({ setMessage });
  const themeSettings = useThemeSettings();
  const [editorFocusRequest, setEditorFocusRequest] = useState<{
    id: number;
    groupId: string;
    documentId: string;
  } | null>(null);
  const editorFocusRequestIdRef = useRef(0);
  const embeddingRevisionsRef = useRef(new Map<string, number>());
  const embeddingFinalizationsRef = useRef(new Map<string, Promise<void>>());
  const explorer = useWorkspaceExplorerState(setMessage, initialWorkspaceState);
  const {
    files: explorerFiles,
    setExpandedDirectories,
    setFiles,
    setNotes,
  } = explorer;
  const refreshAfterObsidianImport = useCallback(async () => {
    const previousIds = new Set(explorerFiles.map((file) => file.id));
    const [filesResult, notesResult] = await Promise.allSettled([
      api<BundleFile[]>("/api/files"),
      api<Note[]>("/api/notes"),
    ]);
    if (filesResult.status === "fulfilled") {
      const newFiles = filesResult.value.filter((file) => !previousIds.has(file.id));
      setFiles(filesResult.value);
      if (newFiles.length) {
        const importedPaths = expandedPathsForFiles(newFiles);
        setExpandedDirectories((current) =>
          new Set([...current, ...importedPaths]),
        );
      }
    }
    if (notesResult.status === "fulfilled") setNotes(notesResult.value);
    if (filesResult.status === "rejected" || notesResult.status === "rejected") {
      setMessage("The import finished, but the file explorer could not be fully refreshed.");
    }
  }, [explorerFiles, setExpandedDirectories, setFiles, setNotes]);
  const obsidianImport = useObsidianImport({
    onImportFinished: refreshAfterObsidianImport,
  });
  const documents = useWorkspaceDocumentState({
    expandedDirectories: explorer.expandedDirectories,
    expandedDirectoriesReady: explorer.expandedDirectoriesReady,
  });
  const layout = useWorkspaceLayout();
  const models = useWorkspaceModels(setMessage);
  const tabs = useWorkspaceTabs({
    documents: documents.documents,
    drafts: documents.drafts,
    notes: explorer.notes,
    files: explorer.files,
    setDocuments: documents.setDocuments,
    setDrafts: documents.setDrafts,
    setEditingKey: documents.setEditingKey,
    draftTitle,
    initialState: initialWorkspaceState,
  });
  const mutations = useWorkspaceDocumentMutations({
    documents,
    setGroups: tabs.setGroups,
    setNotes: explorer.setNotes,
    setFiles: explorer.setFiles,
    setMessage,
    clearDiscovery: explorer.discovery.clearDiscovery,
    replaceDiscoveryDocument: explorer.discovery.replaceDocument,
  });
  const autosave = useFiledDocumentAutosave({
    save: async (documentId, content) => {
      const document = documents.documentsRef.current[documentId];
      if (!document || isUntitledId(documentId)) return;
      if (!content.trim()) {
        setMessage("A note cannot be empty.");
        throw new Error("A note cannot be empty.");
      }
      await mutations.persistDocument(
        document,
        content,
        document.tags,
        true,
        false,
      );
    },
  });

  function markEmbeddingDirty(documentId: string) {
    embeddingRevisionsRef.current.set(
      documentId,
      (embeddingRevisionsRef.current.get(documentId) ?? 0) + 1,
    );
  }

  function finalizeFiledDocument(documentId: string): Promise<void> {
    const existing = embeddingFinalizationsRef.current.get(documentId);
    if (existing) {
      return existing.then(() => {
        if (embeddingRevisionsRef.current.has(documentId))
          return finalizeFiledDocument(documentId);
      });
    }
    const finalization = (async () => {
      while (true) {
        const revision = embeddingRevisionsRef.current.get(documentId);
        if (revision === undefined) return;
        await autosave.flushSave(documentId);
        if (autosave.isDirty(documentId)) return;
        const refreshed = await mutations.refreshDocumentEmbedding(documentId);
        if (!refreshed) return;
        if (embeddingRevisionsRef.current.get(documentId) === revision) {
          embeddingRevisionsRef.current.delete(documentId);
          return;
        }
      }
    })().finally(() => {
      if (embeddingFinalizationsRef.current.get(documentId) === finalization)
        embeddingFinalizationsRef.current.delete(documentId);
    });
    embeddingFinalizationsRef.current.set(documentId, finalization);
    return finalization;
  }

  function finalizeAllFiledDocuments() {
    return Promise.all(
      Array.from(embeddingRevisionsRef.current.keys(), finalizeFiledDocument),
    );
  }
  const navigation = useWorkspaceDocumentNavigation({
    documents,
    groups: tabs.groups,
    setGroups: tabs.setGroups,
    activeGroupId: tabs.activeGroupId,
    setActiveGroupId: tabs.setActiveGroupId,
    closeTab: tabs.closeTab,
    setNotes: explorer.setNotes,
    setFiles: explorer.setFiles,
    setMessage,
    removeDiscoveryDocument: explorer.discovery.removeDocument,
  });

  function closeDocumentTab(groupId: string, documentId: string) {
    setEditorFocusRequest((current) =>
      current?.groupId === groupId && current.documentId === documentId
        ? null
        : current,
    );
    const content = documents.drafts[documentId] ?? documents.documents[documentId]?.content ?? "";
    if (isUntitledId(documentId) && !content.trim()) {
      void navigation.deleteLocalDraft(documentId);
      return;
    }
    if (!isUntitledId(documentId)) void finalizeFiledDocument(documentId);
    tabs.closeTab(groupId, documentId);
  }

  useWorkspaceBootstrap({
    setStatus: models.setStatus,
    setFilesLoading: explorer.setFilesLoading,
    setMessage,
    setNotes: explorer.setNotes,
    setFiles: explorer.setFiles,
    setVersionInfo: models.setVersionInfo,
    mergeRemoteDrafts: documents.mergeRemoteDrafts,
    expandedDirectoriesReadyRef: explorer.expandedDirectoriesReadyRef,
    setExpandedDirectories: explorer.setExpandedDirectories,
    setExpandedDirectoriesReady: explorer.setExpandedDirectoriesReady,
    onWorkspaceDataReady: () => setWorkspaceDataReady(true),
  });

  latestWorkspaceStateRef.current = {
    groups: tabs.groups,
    activeGroupId: tabs.activeGroupId,
    sidebarMode: explorer.sidebarMode,
  };
  explorerScrollTopRef.current = explorer.explorerScrollTop;

  const persistWorkspaceState = useCallback(() => {
    if (!workspaceRestored || !latestWorkspaceStateRef.current) return;
    saveWorkspaceSessionState({
      ...latestWorkspaceStateRef.current,
      explorerScrollTop: explorerScrollTopRef.current,
      documentScrollTops: documentScrollTopsRef.current,
    });
  }, [workspaceRestored]);

  const scheduleScrollPersistence = useCallback(() => {
    if (persistScrollFrameRef.current !== null) return;
    persistScrollFrameRef.current = window.requestAnimationFrame(() => {
      persistScrollFrameRef.current = null;
      persistWorkspaceState();
    });
  }, [persistWorkspaceState]);

  useEffect(() => {
    if (!workspaceRestored) return;
    persistWorkspaceState();
  }, [
    explorer.explorerScrollTop,
    explorer.sidebarMode,
    tabs.activeGroupId,
    tabs.groups,
    workspaceRestored,
    persistWorkspaceState,
  ]);

  useEffect(() => {
    if (!workspaceDataReady || workspaceRestored || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const localIds = new Set(Object.keys(documents.documents));
    const noteIds = new Set(explorer.notes.map((note) => note.id));
    const fileIds = new Set(explorer.files.map((file) => file.id));
    const validIds = new Set([...localIds, ...noteIds, ...fileIds]);
    documentScrollTopsRef.current = Object.fromEntries(
      Object.entries(documentScrollTopsRef.current).filter(([id]) =>
        validIds.has(id),
      ),
    );
    const restoredGroups = tabs.groups.map((group) => {
      const tabsForGroup = group.tabs.filter((id) => validIds.has(id));
      return {
        ...group,
        tabs: tabsForGroup,
        activeId: group.activeId && tabsForGroup.includes(group.activeId)
          ? group.activeId
          : tabsForGroup[0] ?? null,
        previewId: group.previewId && tabsForGroup.includes(group.previewId)
          ? group.previewId
          : null,
      };
    });
    const nextGroups = restoredGroups.length
      ? restoredGroups
      : [{ id: "primary", tabs: [], activeId: null, previewId: null }];
    const nextActiveGroupId = nextGroups.some(
      (group) => group.id === tabs.activeGroupId,
    )
      ? tabs.activeGroupId
      : nextGroups[0].id;
    tabs.setGroups(nextGroups);
    tabs.setActiveGroupId(nextActiveGroupId);
    const filedToRestore = nextGroups.flatMap((group) =>
      group.tabs
        .filter((id) => !localIds.has(id) && !documents.documents[id])
        .map((id) => ({
          id,
          groupId: group.id,
          source: noteIds.has(id) ? ("note" as const) : ("file" as const),
        })),
    );
    void Promise.all(
      filedToRestore.map(({ id, groupId, source }) =>
        navigation.openDocument(id, source, groupId, "permanent"),
      ),
    ).finally(() => {
      tabs.setGroups((current) =>
        current.map((group) => {
          const restored = nextGroups.find((candidate) => candidate.id === group.id);
          return restored
            ? {
                ...group,
                activeId:
                  restored.activeId && group.tabs.includes(restored.activeId)
                    ? restored.activeId
                    : group.activeId,
                previewId:
                  restored.previewId && group.tabs.includes(restored.previewId)
                    ? restored.previewId
                    : group.previewId,
              }
            : group;
        }),
      );
      tabs.setActiveGroupId(nextActiveGroupId);
      setWorkspaceRestored(true);
    });
  }, [
    documents.documents,
    explorer.files,
    explorer.notes,
    navigation,
    tabs,
    workspaceDataReady,
    workspaceRestored,
  ]);

  useEffect(() => {
    const flush = () => {
      if (persistScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(persistScrollFrameRef.current);
        persistScrollFrameRef.current = null;
      }
      persistWorkspaceState();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persistWorkspaceState]);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 3_000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useWorkspaceShortcutActions({
    sidebarMode: explorer.sidebarMode,
    setSidebarMode: explorer.setSidebarMode,
    searchInputRef: explorer.searchInputRef,
    groups: tabs.groups,
    activeGroupId: tabs.activeGroupId,
    documents: documents.documents,
    createNewTab: () => {
      setEditorFocusRequest(null);
      tabs.createNewTab();
    },
    activateTabAtEnd: (groupId, documentId) => {
      const group = tabs.groups.find((candidate) => candidate.id === groupId);
      if (groupId !== tabs.activeGroupId || group?.activeId !== documentId)
        void finalizeAllFiledDocuments();
      tabs.activateTab(groupId, documentId);
      setEditorFocusRequest({
        id: ++editorFocusRequestIdRef.current,
        groupId,
        documentId,
      });
    },
    closeTab: closeDocumentTab,
    fileDraft: mutations.fileDraft,
    flushDocument: finalizeFiledDocument,
    exportDocument: (document, format) =>
      void noteExport.exportDocument(
        document,
        documents.drafts[document.id],
        format,
      ),
    openSettings: themeSettings.openSettings,
  });

  const { sidebar, moveBundleFile } = useWorkspaceSidebarProps({
    explorer,
    documents,
    groups: tabs.groups,
    setGroups: tabs.setGroups,
    models,
    setMessage,
    draftTitle,
    openLocalDraft: (id) => {
      setEditorFocusRequest(null);
      tabs.openLocalDraft(id);
    },
    deleteLocalDraft: navigation.deleteLocalDraft,
    openDocument: async (...args) => {
      setEditorFocusRequest(null);
      void finalizeAllFiledDocuments();
      return navigation.openDocument(...args);
    },
  });

  return {
    exportPreview: noteExport.preview,
    topBar: {
      versionInfo: models.versionInfo,
      status: models.status,
      missingModels: models.missingModels,
      modelInstallInProgress: models.modelInstallInProgress,
      modelEndpoints: models.modelEndpoints,
      togglingService: models.togglingService,
      onInstall: models.installOllamaModels,
      onToggle: models.toggleOllamaService,
      onOpenSettings: themeSettings.openSettings,
    },
    settings: {
      open: themeSettings.settingsOpen,
      themeId: themeSettings.themeId,
      onSelectTheme: themeSettings.selectTheme,
      obsidianImport,
      onClose: themeSettings.closeSettings,
    },
    sidebar,
    layout: {
      sidebarWidth: layout.sidebarWidth,
      beginHorizontalResize: layout.beginHorizontalResize,
      finishHorizontalResize: layout.finishHorizontalResize,
      resizeSidebar: layout.resizeSidebar,
      resetSidebar: () => layout.setSidebarWidth(null),
    },
    editor: {
      model: {
        groups: tabs.groups,
        splitPosition: layout.splitPosition,
        activeGroupId: tabs.activeGroupId,
        documents: documents.documents,
        loadingDocuments: documents.loadingDocuments,
        savingDocuments: documents.savingDocuments,
        editingKey: documents.editingKey,
        drafts: documents.drafts,
        deletingNoteId: documents.deletingNoteId,
        movingFileId: explorer.movingFileId,
        filingDirectories: bundleDirectories(explorer.files),
        filingQueues: documents.filingQueues,
        editorFocusRequest,
        message,
        exportingNoteId: noteExport.exportingNoteId,
      },
      actions: {
        beginHorizontalResize: layout.beginHorizontalResize,
        resizeSplit: layout.resizeSplit,
        finishHorizontalResize: layout.finishHorizontalResize,
        resetSplit: () => layout.setSplitPosition(50),
        activateGroup: (groupId) => {
          if (groupId !== tabs.activeGroupId) {
            setEditorFocusRequest(null);
            void finalizeAllFiledDocuments();
          }
          tabs.setActiveGroupId(groupId);
        },
        moveTabToGroup: (documentId, sourceGroupId, targetGroupId) => {
          setEditorFocusRequest(null);
          tabs.moveTabToGroup(documentId, sourceGroupId, targetGroupId);
        },
        titleForId: tabs.titleForId,
        activateTab: (groupId, documentId) => {
          setEditorFocusRequest(null);
          const group = tabs.groups.find((candidate) => candidate.id === groupId);
          if (groupId !== tabs.activeGroupId || group?.activeId !== documentId)
            void finalizeAllFiledDocuments();
          tabs.activateTab(groupId, documentId);
        },
        pinTab: tabs.pinTab,
        consumeEditorFocusRequest: (requestId) =>
          setEditorFocusRequest((current) =>
            current?.id === requestId ? null : current,
          ),
        createNewTab: (targetGroupId) => {
          setEditorFocusRequest(null);
          tabs.createNewTab(targetGroupId);
        },
        splitWorkspace: () => {
          setEditorFocusRequest(null);
          tabs.splitWorkspace();
        },
        closeGroup: (groupId) => {
          setEditorFocusRequest(null);
          void finalizeAllFiledDocuments();
          tabs.closeGroup(groupId);
        },
        closeTab: closeDocumentTab,
        changeDraftContent: (document, content) => {
          documents.changeDraftContent(document, content);
          if (!isUntitledId(document.id)) {
            markEmbeddingDirty(document.id);
            autosave.scheduleSave(document.id, content);
          }
        },
        fileDraft: mutations.fileDraft,
        changeFilingFields: mutations.changeFilingFields,
        revealStandaloneFiling: mutations.revealStandaloneFiling,
        confirmFiling: mutations.confirmFiling,
        dismissFiling: mutations.dismissFiling,
        beginEditing: (groupId, document) => {
          tabs.pinTab(groupId, document.id);
          mutations.beginEditing(groupId, document);
        },
        finishEditing: (groupId, document, scrollTop) => {
          mutations.finishEditing(groupId, document, scrollTop);
          if (!isUntitledId(document.id))
            void finalizeFiledDocument(document.id);
        },
        openDocument: async (...args) => {
          setEditorFocusRequest(null);
          void finalizeAllFiledDocuments();
          return navigation.openDocument(...args);
        },
        toggleTaskCheckbox: mutations.toggleTaskCheckbox,
        deleteFiledNote: async (document) => {
          await autosave.flushSave(document.id);
          return navigation.deleteFiledNote(document);
        },
        persistDocument: mutations.persistDocument,
        persistMetadata: mutations.persistMetadata,
        moveBundleFile: async (id, directory) => {
          await finalizeFiledDocument(id);
          return moveBundleFile(id, directory);
        },
        getDocumentScrollTop: (documentId) =>
          documentScrollTopsRef.current[documentId] ?? 0,
        rememberDocumentScrollTop: (documentId, scrollTop) => {
          if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
          documentScrollTopsRef.current[documentId] = scrollTop;
          scheduleScrollPersistence();
        },
        exportDocument: (document, format) =>
          void noteExport.exportDocument(
            document,
            documents.drafts[document.id],
            format,
          ),
        dismissMessage: () => setMessage(""),
      },
    },
  };
}
