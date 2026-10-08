import type { Dispatch, SetStateAction } from "react";
import type { TabGroup } from "../../../domain/types.ts";
import { conceptUrl } from "../../../lib/paths.ts";
import { buildFileTree } from "../../../lib/tree.ts";
import {
  formatDate,
  isUntitledId,
} from "../../../lib/workspace.ts";
import { useWorkspaceBundleActions } from "./useWorkspaceBundleActions.ts";
import { useWorkspaceExplorerActions } from "./useWorkspaceExplorerActions.ts";
import type { NoteExportFormat } from "../model/note-export.ts";
import type { WorkspaceSidebarProps } from "../../sidebar/WorkspaceSidebar.tsx";
import type { WorkspaceDocumentState } from "./useWorkspaceDocumentState.ts";
import type { WorkspaceExplorerState } from "./useWorkspaceExplorerState.ts";
import type { ReturnTypeOfWorkspaceModels } from "./useWorkspaceModels.ts";
import type { useBundleSetup } from "../../settings/hooks/useBundleSetup.ts";

type Options = {
  explorer: WorkspaceExplorerState;
  documents: WorkspaceDocumentState;
  groups: TabGroup[];
  activeGroupId: string;
  activeFileRevealRequest: number;
  setGroups: Dispatch<SetStateAction<TabGroup[]>>;
  models: ReturnTypeOfWorkspaceModels;
  setMessage: Dispatch<SetStateAction<string>>;
  draftTitle: (content: string) => string;
  createNewTab: (initialContent?: string) => void;
  openLocalDraft: (id: string) => void;
  deleteLocalDraft: (id: string) => Promise<void>;
  openDocument: WorkspaceSidebarProps["openDocument"];
  deleteFiledNote: (file: Pick<import("../../../domain/types.ts").BundleFile, "id" | "title" | "deletable">) => Promise<void>;
  exportFile: (file: import("../../../domain/types.ts").BundleFile, format: NoteExportFormat) => Promise<void>;
  bundleSetup: ReturnType<typeof useBundleSetup>;
  openSettings: () => void;
  isDocumentDirty: (id: string) => boolean;
};

export function useWorkspaceSidebarProps({
  explorer,
  documents,
  groups,
  activeGroupId,
  activeFileRevealRequest,
  setGroups,
  models,
  setMessage,
  draftTitle,
  createNewTab,
  openLocalDraft,
  deleteLocalDraft,
  openDocument,
  deleteFiledNote,
  exportFile,
  bundleSetup,
  openSettings,
  isDocumentDirty,
}: Options): {
  sidebar: WorkspaceSidebarProps;
  moveBundleFile: ReturnType<typeof useWorkspaceBundleActions>["moveBundleFile"];
  reindexBundle: ReturnType<typeof useWorkspaceBundleActions>["reindexBundle"];
} {
  const { reindexBundle, moveBundleFile } = useWorkspaceBundleActions(
    {
      reindexing: explorer.reindexing,
      groups,
      files: explorer.files,
      editingKey: documents.editingKey,
      movingFileId: explorer.movingFileId,
      savingDocuments: documents.savingDocuments,
      loadingDocuments: documents.loadingDocuments,
      deletingDirectories: documents.deletingDirectories,
    },
    {
      setReindexing: explorer.setReindexing,
      setMessage,
      setNotes: explorer.setNotes,
      setFiles: explorer.setFiles,
      setDirectories: explorer.setDirectories,
      setDocuments: documents.setDocuments,
      setGroups,
      setEditingKey: documents.setEditingKey,
      clearDiscovery: explorer.discovery.clearDiscovery,
      setMovingFileId: explorer.setMovingFileId,
      setDrafts: documents.setDrafts,
      setExpandedDirectories: explorer.setExpandedDirectories,
      setDraggedFileId: explorer.setDraggedFileId,
      setDropDirectoryPath: explorer.setDropDirectoryPath,
    },
  );
  const blockedFileIds = new Set([
    ...documents.savingDocuments,
    ...documents.loadingDocuments,
    ...(explorer.movingFileId ? [explorer.movingFileId] : []),
    ...Object.keys(documents.documents).filter(isDocumentDirty),
  ]);
  for (const group of groups) {
    if (documents.editingKey?.startsWith(`${group.id}:`))
      blockedFileIds.add(documents.editingKey.slice(group.id.length + 1));
  }
  const localDraftDocuments = Object.values(documents.documents)
    .filter((document) => isUntitledId(document.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const activeFileId = groups.find((group) => group.id === activeGroupId)?.activeId ?? null;
  const activeFileDirectory = activeFileId
    ? explorer.files.find((file) => file.id === activeFileId)?.directory ?? null
    : null;
  const availableTags = Array.from(
    new Set(explorer.notes.flatMap((note) => note.tags)),
  ).sort((left, right) => left.localeCompare(right));
  const discovery = explorer.discovery;
  const explorerActions = useWorkspaceExplorerActions({
    files: explorer.files,
    groups,
    editingKey: documents.editingKey,
    savingDocuments: documents.savingDocuments,
    movingFileId: explorer.movingFileId,
    documentRequests: documents.documentRequests,
    documentsRef: documents.documentsRef,
    draftsRef: documents.draftsRef,
    deletingDirectories: documents.deletingDirectories,
    directoryDeletions: documents.directoryDeletions,
    documentMutationSequence: documents.documentMutationSequence,
    isDocumentDirty,
    removeDiscoveryDirectory: discovery.removeDirectory,
    setLoadingDocuments: documents.setLoadingDocuments,
    setEditingKey: documents.setEditingKey,
    setFiles: explorer.setFiles,
    setDirectories: explorer.setDirectories,
    setNotes: explorer.setNotes,
    setDocuments: documents.setDocuments,
    setDrafts: documents.setDrafts,
    setGroups,
    setExpandedDirectories: explorer.setExpandedDirectories,
    setMessage,
    deleteFiledNote,
    exportFile,
    createNewTab,
  });

  return {
    moveBundleFile,
    reindexBundle,
    sidebar: {
      sidebarMode: explorer.sidebarMode,
      setSidebarMode: explorer.setSidebarMode,
      explorerScrollTop: explorer.explorerScrollTop,
      onExplorerScroll: explorer.rememberExplorerScrollTop,
      filesLoading: explorer.filesLoading,
      localDraftDocuments,
      drafts: documents.drafts,
      draftTitle,
      openLocalDraft,
      deleteLocalDraft,
      deletingDraftIds: documents.deletingDraftIds,
      savingDocuments: documents.savingDocuments,
      fileTree: buildFileTree(explorer.files, explorer.directories),
      activeFileId,
      activeFileDirectory,
      activeFileRevealRequest,
      expandedDirectories: explorer.expandedDirectories,
      draggedFileId: explorer.draggedFileId,
      dropDirectoryPath: explorer.dropDirectoryPath,
      movingFileId: explorer.movingFileId,
      blockedFileIds,
      setExpandedDirectories: explorer.setExpandedDirectories,
      openDocument,
      setDraggedFileId: explorer.setDraggedFileId,
      setDropDirectoryPath: explorer.setDropDirectoryPath,
      moveBundleFile,
      actions: explorerActions,
      setMessage,
      bundles: bundleSetup.bundles,
      activeBundleId: bundleSetup.activeBundleId,
      selectBundle: bundleSetup.selectBundle,
      openSettings,
      notes: explorer.notes,
      searchInputRef: explorer.searchInputRef,
      searchQuery: discovery.searchQuery,
      setSearchQuery: discovery.setSearchQuery,
      selectedTag: discovery.selectedTag,
      searching: discovery.searching,
      searchNotes: discovery.searchNotes,
      availableTags,
      setSelectedTag: discovery.setSelectedTag,
      setSearchResults: discovery.setSearchResults,
      searchTag: discovery.searchTag,
      searchResults: discovery.searchResults,
      selectedAnswerModel: models.selectedAnswerModel,
      asking: discovery.asking,
      question: discovery.question,
      setQuestion: discovery.setQuestion,
      selectedAnswerModelMissing: models.selectedAnswerModelMissing,
      askNotes: () => discovery.askNotes(models.selectedAnswerModel),
      answer: discovery.answer,
      conceptUrl,
      formatDate,
    },
  };
}
