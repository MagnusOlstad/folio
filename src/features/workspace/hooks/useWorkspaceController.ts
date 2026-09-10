import { useEffect, useRef, useState } from "react";
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
import { isUntitledId } from "../../../lib/workspace.ts";
import { bundleDirectories } from "../model/directory-suggestions.ts";
import { useThemeSettings } from "../../settings/hooks/useThemeSettings.ts";
import { useObsidianImport } from "../../settings/hooks/useObsidianImport.ts";

function draftTitle(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 48) : "Untitled";
}

export function useWorkspaceController(): WorkspaceShellProps {
  const [message, setMessage] = useState("");
  const themeSettings = useThemeSettings();
  const obsidianImport = useObsidianImport();
  const embeddingRevisionsRef = useRef(new Map<string, number>());
  const embeddingFinalizationsRef = useRef(new Map<string, Promise<void>>());
  const explorer = useWorkspaceExplorerState(setMessage);
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
    activateTab: tabs.activateTab,
    closeTab: tabs.closeTab,
    setNotes: explorer.setNotes,
    setFiles: explorer.setFiles,
    setMessage,
    removeDiscoveryDocument: explorer.discovery.removeDocument,
  });

  function closeDocumentTab(groupId: string, documentId: string) {
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
    createNewTab: tabs.createNewTab,
    activateTab: (groupId, documentId) => {
      const group = tabs.groups.find((candidate) => candidate.id === groupId);
      if (groupId !== tabs.activeGroupId || group?.activeId !== documentId)
        void finalizeAllFiledDocuments();
      tabs.activateTab(groupId, documentId);
    },
    closeTab: closeDocumentTab,
    fileDraft: mutations.fileDraft,
    flushDocument: finalizeFiledDocument,
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
    openLocalDraft: tabs.openLocalDraft,
    deleteLocalDraft: navigation.deleteLocalDraft,
    openDocument: async (...args) => {
      void finalizeAllFiledDocuments();
      return navigation.openDocument(...args);
    },
  });

  return {
    topBar: {
      versionInfo: models.versionInfo,
      status: models.status,
      missingModels: models.missingModels,
      modelInstallInProgress: models.modelInstallInProgress,
      modelEndpoints: models.modelEndpoints,
      togglingService: models.togglingService,
      showSettingsButton: !window.folio,
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
        message,
      },
      actions: {
        beginHorizontalResize: layout.beginHorizontalResize,
        resizeSplit: layout.resizeSplit,
        finishHorizontalResize: layout.finishHorizontalResize,
        resetSplit: () => layout.setSplitPosition(50),
        activateGroup: (groupId) => {
          if (groupId !== tabs.activeGroupId)
            void finalizeAllFiledDocuments();
          tabs.setActiveGroupId(groupId);
        },
        moveTabToGroup: tabs.moveTabToGroup,
        titleForId: tabs.titleForId,
        activateTab: (groupId, documentId) => {
          const group = tabs.groups.find((candidate) => candidate.id === groupId);
          if (groupId !== tabs.activeGroupId || group?.activeId !== documentId)
            void finalizeAllFiledDocuments();
          tabs.activateTab(groupId, documentId);
        },
        createNewTab: tabs.createNewTab,
        splitWorkspace: tabs.splitWorkspace,
        closeGroup: (groupId) => {
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
        beginEditing: mutations.beginEditing,
        finishEditing: (groupId, document, scrollTop) => {
          mutations.finishEditing(groupId, document, scrollTop);
          if (!isUntitledId(document.id))
            void finalizeFiledDocument(document.id);
        },
        openDocument: async (...args) => {
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
        dismissMessage: () => setMessage(""),
      },
    },
  };
}
