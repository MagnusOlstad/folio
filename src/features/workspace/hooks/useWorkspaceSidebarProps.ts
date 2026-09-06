import type { Dispatch, SetStateAction } from "react";
import type { TabGroup } from "../../../domain/types.ts";
import { conceptUrl } from "../../../lib/paths.ts";
import { buildFileTree } from "../../../lib/tree.ts";
import {
  formatDate,
  hasInstalledModel,
  isUntitledId,
} from "../../../lib/workspace.ts";
import { useWorkspaceBundleActions } from "./useWorkspaceBundleActions.ts";
import type { WorkspaceSidebarProps } from "../../sidebar/WorkspaceSidebar.tsx";
import type { WorkspaceDocumentState } from "./useWorkspaceDocumentState.ts";
import type { WorkspaceExplorerState } from "./useWorkspaceExplorerState.ts";
import type { ReturnTypeOfWorkspaceModels } from "./useWorkspaceModels.ts";

type Options = {
  explorer: WorkspaceExplorerState;
  documents: WorkspaceDocumentState;
  groups: TabGroup[];
  setGroups: Dispatch<SetStateAction<TabGroup[]>>;
  models: ReturnTypeOfWorkspaceModels;
  setMessage: Dispatch<SetStateAction<string>>;
  draftTitle: (content: string) => string;
  openLocalDraft: (id: string) => void;
  deleteLocalDraft: (id: string) => Promise<void>;
  openDocument: WorkspaceSidebarProps["openDocument"];
};

export function useWorkspaceSidebarProps({
  explorer,
  documents,
  groups,
  setGroups,
  models,
  setMessage,
  draftTitle,
  openLocalDraft,
  deleteLocalDraft,
  openDocument,
}: Options): {
  sidebar: WorkspaceSidebarProps;
  moveBundleFile: ReturnType<typeof useWorkspaceBundleActions>["moveBundleFile"];
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
    },
    {
      setReindexing: explorer.setReindexing,
      setMessage,
      setNotes: explorer.setNotes,
      setFiles: explorer.setFiles,
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
  ]);
  for (const group of groups) {
    if (documents.editingKey?.startsWith(`${group.id}:`))
      blockedFileIds.add(documents.editingKey.slice(group.id.length + 1));
  }
  const localDraftDocuments = Object.values(documents.documents)
    .filter((document) => isUntitledId(document.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const availableTags = Array.from(
    new Set(explorer.notes.flatMap((note) => note.tags)),
  ).sort((left, right) => left.localeCompare(right));
  const discovery = explorer.discovery;

  return {
    moveBundleFile,
    sidebar: {
      sidebarMode: explorer.sidebarMode,
      setSidebarMode: explorer.setSidebarMode,
      reindexing: explorer.reindexing,
      reindexBundle,
      filesLoading: explorer.filesLoading,
      localDraftDocuments,
      drafts: documents.drafts,
      draftTitle,
      openLocalDraft,
      deleteLocalDraft,
      deletingDraftIds: documents.deletingDraftIds,
      savingDocuments: documents.savingDocuments,
      fileTree: buildFileTree(explorer.files),
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
      status: models.status,
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
      setAskModel: models.setAskModel,
      setAnswer: discovery.setAnswer,
      asking: discovery.asking,
      configuredAnswerModels: models.configuredAnswerModels,
      hasInstalledModel,
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
