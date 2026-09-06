import { useRef, useState } from "react";
import type { BundleFile, Note, SidebarMode } from "../../../domain/types.ts";
import { loadExpandedDirectoryState } from "../../../lib/storage.ts";
import { useWorkspaceDiscovery } from "./useWorkspaceDiscovery.ts";

export function useWorkspaceExplorerState(
  setMessage: (message: string) => void,
) {
  const [initialExpandedDirectoryState] = useState(loadExpandedDirectoryState);
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
  const expandedDirectoriesReadyRef = useRef(
    initialExpandedDirectoryState.restored,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const [dropDirectoryPath, setDropDirectoryPath] = useState<string | null>(
    null,
  );
  const [movingFileId, setMovingFileId] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const discovery = useWorkspaceDiscovery({ setMessage, setSidebarMode });

  return {
    sidebarMode,
    setSidebarMode,
    notes,
    setNotes,
    files,
    setFiles,
    filesLoading,
    setFilesLoading,
    expandedDirectories,
    setExpandedDirectories,
    expandedDirectoriesReady,
    setExpandedDirectoriesReady,
    expandedDirectoriesReadyRef,
    searchInputRef,
    draggedFileId,
    setDraggedFileId,
    dropDirectoryPath,
    setDropDirectoryPath,
    movingFileId,
    setMovingFileId,
    reindexing,
    setReindexing,
    discovery,
  };
}

export type WorkspaceExplorerState = ReturnType<
  typeof useWorkspaceExplorerState
>;
