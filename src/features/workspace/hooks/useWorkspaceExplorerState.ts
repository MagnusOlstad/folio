import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleFile, Note, SidebarMode } from "../../../domain/types.ts";
import { loadExpandedDirectoryState } from "../../../lib/storage.ts";
import { useWorkspaceDiscovery } from "./useWorkspaceDiscovery.ts";
import type { WorkspaceSessionState } from "../model/workspace-state.ts";

export function useWorkspaceExplorerState(
  setMessage: (message: string) => void,
  initialState?: WorkspaceSessionState | null,
) {
  const [initialExpandedDirectoryState] = useState(loadExpandedDirectoryState);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(
    initialState?.sidebarMode ?? "explore",
  );
  const [explorerScrollTop, setExplorerScrollTop] = useState(
    initialState?.explorerScrollTop ?? 0,
  );
  const explorerScrollTopRef = useRef(explorerScrollTop);
  const explorerScrollFrameRef = useRef<number | null>(null);
  const rememberExplorerScrollTop = useCallback((scrollTop: number) => {
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
    explorerScrollTopRef.current = scrollTop;
    if (explorerScrollFrameRef.current !== null) return;
    explorerScrollFrameRef.current = window.requestAnimationFrame(() => {
      explorerScrollFrameRef.current = null;
      setExplorerScrollTop(explorerScrollTopRef.current);
    });
  }, []);
  useEffect(() => () => {
    if (explorerScrollFrameRef.current !== null)
      window.cancelAnimationFrame(explorerScrollFrameRef.current);
  }, []);
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
    explorerScrollTop,
    setExplorerScrollTop,
    rememberExplorerScrollTop,
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
