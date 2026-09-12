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
  useWorkspaceSessionPersistence,
} from "./useWorkspaceSessionPersistence.ts";
import { loadWorkspaceSessionState } from "../model/workspace-state.ts";
import { useTranscription } from "../../transcription/hooks/useTranscription.ts";

function draftTitle(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 48) : "Untitled";
}

export function useWorkspaceController(): WorkspaceShellProps {
  const [message, setMessage] = useState("");
  const [initialWorkspaceState] = useState(loadWorkspaceSessionState);
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
  const transcription = useTranscription({
    drafts: {
      createDraft: () => tabs.createNewTab(),
      getDraftContent: (id) =>
        documents.drafts[id] ?? documents.documentsRef.current[id]?.content,
      getDraftDocument: (id) => documents.documentsRef.current[id],
      updateDraftContent: (id, content) => {
        const document = documents.documentsRef.current[id] ?? documents.documents[id];
        if (document) documents.changeDraftContent(document, content);
        else documents.setDrafts((current) => ({ ...current, [id]: content }));
      },
      openDraft: (id) => tabs.openLocalDraft(id),
      fileDraft: (document, content) => mutations.fileDraft(document, content),
    },
    setMessage,
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

  const session = useWorkspaceSessionPersistence({
    initialState: initialWorkspaceState,
    documents: documents.documents,
    notes: explorer.notes,
    files: explorer.files,
    groups: tabs.groups,
    activeGroupId: tabs.activeGroupId,
    sidebarMode: explorer.sidebarMode,
    explorerScrollTop: explorer.explorerScrollTop,
    setGroups: tabs.setGroups,
    setActiveGroupId: tabs.setActiveGroupId,
    loadDocument: navigation.loadDocument,
    onLoadError: (_documentId, error) => {
      setMessage(error instanceof Error ? error.message : "Could not restore document");
    },
  });

  const ensureDocumentLoaded = useCallback((documentId: string) => {
    if (documents.documents[documentId] || documents.loadingDocuments.has(documentId)) return;
    const source = explorer.notes.some((note) => note.id === documentId) ? "note" : "file";
    void navigation.loadDocument(documentId, source).catch((error) => {
      setMessage(error instanceof Error ? error.message : "Could not open file");
    });
  }, [documents.documents, documents.loadingDocuments, explorer.notes, navigation]);

  function closeDocumentTab(groupId: string, documentId: string) {
    if (transcription.isDraftBusy(documentId)) {
      setMessage("Stop or finish the transcription before closing its draft.");
      return;
    }
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
    onWorkspaceDataReady: session.markWorkspaceDataReady,
  });

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
      ensureDocumentLoaded(documentId);
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
    newTranscription: transcription.actions.start,
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
    deleteLocalDraft: async (id) => {
      if (transcription.isDraftBusy(id)) {
        setMessage("Stop or finish the transcription before deleting its draft.");
        return;
      }
      return navigation.deleteLocalDraft(id);
    },
    openDocument: async (...args) => {
      setEditorFocusRequest(null);
      void finalizeAllFiledDocuments();
      return navigation.openDocument(...args);
    },
  });

  return {
    exportPreview: noteExport.preview,
    transcriptions: transcription,
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
          ensureDocumentLoaded(documentId);
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
          session.getDocumentScrollTop(documentId),
        rememberDocumentScrollTop: session.rememberDocumentScrollTop,
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
