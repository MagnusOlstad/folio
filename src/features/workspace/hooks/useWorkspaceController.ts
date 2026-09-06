import { useEffect, useState } from "react";
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

function draftTitle(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 48) : "Untitled";
}

export function useWorkspaceController(): WorkspaceShellProps {
  const [message, setMessage] = useState("");
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
    drafts: documents.drafts,
    editingKey: documents.editingKey,
    createNewTab: tabs.createNewTab,
    closeTab: tabs.closeTab,
    fileDraft: mutations.fileDraft,
    persistDocument: mutations.persistDocument,
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
    openDocument: navigation.openDocument,
  });

  return {
    topBar: {
      versionInfo: models.versionInfo,
      status: models.status,
      missingModels: models.missingModels,
      modelInstallInProgress: models.modelInstallInProgress,
      modelEndpoints: models.modelEndpoints,
      togglingService: models.togglingService,
      onInstall: models.installOllamaModels,
      onToggle: models.toggleOllamaService,
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
        editorIntents: documents.editorIntents,
        drafts: documents.drafts,
        deletingNoteId: documents.deletingNoteId,
        movingFileId: explorer.movingFileId,
        message,
      },
      actions: {
        beginHorizontalResize: layout.beginHorizontalResize,
        resizeSplit: layout.resizeSplit,
        finishHorizontalResize: layout.finishHorizontalResize,
        resetSplit: () => layout.setSplitPosition(50),
        activateGroup: tabs.setActiveGroupId,
        moveTabToGroup: tabs.moveTabToGroup,
        titleForId: tabs.titleForId,
        activateTab: tabs.activateTab,
        createNewTab: tabs.createNewTab,
        splitWorkspace: tabs.splitWorkspace,
        closeGroup: tabs.closeGroup,
        closeTab: tabs.closeTab,
        changeDraftContent: documents.changeDraftContent,
        fileDraft: mutations.fileDraft,
        beginEditing: mutations.beginEditing,
        finishEditing: mutations.finishEditing,
        restoreReaderScroll: documents.restoreReaderScroll,
        openDocument: navigation.openDocument,
        toggleTaskCheckbox: mutations.toggleTaskCheckbox,
        deleteFiledNote: navigation.deleteFiledNote,
        persistDocument: mutations.persistDocument,
        persistMetadata: mutations.persistMetadata,
        moveBundleFile,
        dismissMessage: () => setMessage(""),
      },
    },
  };
}
