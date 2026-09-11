import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleFile, Note, SidebarMode, TabGroup, ViewerDocument } from "../../../domain/types.ts";
import {
  pruneDocumentScrollTops,
  reconcileWorkspaceSessionState,
  WORKSPACE_STATE_STORAGE_KEY,
  WORKSPACE_STATE_VERSION,
  type WorkspaceSessionState,
} from "../model/workspace-state.ts";
import { writeStorageItem } from "../../../lib/storage.ts";

type UseWorkspaceSessionPersistenceOptions = {
  initialState: WorkspaceSessionState | null;
  documents: Record<string, ViewerDocument>;
  notes: Note[];
  files: BundleFile[];
  groups: TabGroup[];
  activeGroupId: string;
  sidebarMode: SidebarMode;
  explorerScrollTop: number;
  setGroups: React.Dispatch<React.SetStateAction<TabGroup[]>>;
  setActiveGroupId: React.Dispatch<React.SetStateAction<string>>;
  loadDocument: (id: string, source: "note" | "file") => Promise<void>;
  onLoadError?: (documentId: string, error: unknown) => void;
};

const PERSIST_DEBOUNCE_MS = 400;

export function useWorkspaceSessionPersistence({
  initialState,
  documents,
  notes,
  files,
  groups,
  activeGroupId,
  sidebarMode,
  explorerScrollTop,
  setGroups,
  setActiveGroupId,
  loadDocument,
  onLoadError,
}: UseWorkspaceSessionPersistenceOptions) {
  const [workspaceDataReady, setWorkspaceDataReady] = useState(initialState === null);
  const [workspaceRestored, setWorkspaceRestored] = useState(initialState === null);
  const documentScrollTopsRef = useRef<Record<string, number>>(
    initialState?.documentScrollTops ?? {},
  );
  const explorerScrollTopRef = useRef(initialState?.explorerScrollTop ?? 0);
  const latestStateRef = useRef<{
    groups: TabGroup[];
    activeGroupId: string;
    sidebarMode: SidebarMode;
  } | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const restoreStartedRef = useRef(false);
  const workspaceRestoredRef = useRef(workspaceRestored);
  const validIdsRef = useRef(new Set<string>());

  useEffect(() => {
    explorerScrollTopRef.current = explorerScrollTop;
    latestStateRef.current = { groups, activeGroupId, sidebarMode };
    workspaceRestoredRef.current = workspaceRestored;
    validIdsRef.current = new Set([
      ...Object.keys(documents),
      ...notes.map((note) => note.id),
      ...files.map((file) => file.id),
    ]);
  }, [activeGroupId, documents, explorerScrollTop, files, groups, notes, sidebarMode, workspaceRestored]);

  const save = useCallback(() => {
    const current = latestStateRef.current;
    if (!workspaceRestoredRef.current || !current) return;
    const state = {
      ...current,
      explorerScrollTop: explorerScrollTopRef.current,
      documentScrollTops: pruneDocumentScrollTops(
        documentScrollTopsRef.current,
        validIdsRef.current,
      ),
    };
    writeStorageItem(
      WORKSPACE_STATE_STORAGE_KEY,
      JSON.stringify({ version: WORKSPACE_STATE_VERSION, ...state }),
    );
  }, []);

  const scheduleSave = useCallback(() => {
    if (!workspaceRestored) return;
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      save();
    }, PERSIST_DEBOUNCE_MS);
  }, [save, workspaceRestored]);

  useEffect(() => {
    if (workspaceRestored) scheduleSave();
  }, [activeGroupId, groups, scheduleSave, sidebarMode, workspaceRestored]);

  useEffect(() => {
    if (!workspaceDataReady || workspaceRestored || restoreStartedRef.current || !initialState)
      return;
    restoreStartedRef.current = true;
    const validIds = new Set([
      ...Object.keys(documents),
      ...notes.map((note) => note.id),
      ...files.map((file) => file.id),
    ]);
    // Tabs are seeded synchronously from the stored state. Reconcile the
    // current selection so interactions made while bootstrap was pending win.
    const reconciled = reconcileWorkspaceSessionState(
      { ...initialState, groups, activeGroupId },
      validIds,
    );
    documentScrollTopsRef.current = pruneDocumentScrollTops(
      documentScrollTopsRef.current,
      validIds,
    );
    setGroups(reconciled.groups);
    setActiveGroupId(reconciled.activeGroupId);
    // Mark restored before starting requests. Completion must never reapply the
    // captured tab selection after the user has interacted with the workspace.
    setWorkspaceRestored(true);
    const noteIds = new Set(notes.map((note) => note.id));
    const activeDocuments = reconciled.groups.flatMap((group) =>
      group.activeId
        ? [{ id: group.activeId, source: noteIds.has(group.activeId) ? ("note" as const) : ("file" as const) }]
        : [],
    );
    for (const document of activeDocuments)
      void loadDocument(document.id, document.source).catch((error) =>
        onLoadError?.(document.id, error),
      );
  }, [activeGroupId, documents, files, groups, initialState, loadDocument, notes, onLoadError, setActiveGroupId, setGroups, workspaceDataReady, workspaceRestored]);

  useEffect(() => {
    const flush = () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      save();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [save]);

  const rememberDocumentScrollTop = useCallback((documentId: string, scrollTop: number) => {
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
    const next = { ...documentScrollTopsRef.current };
    delete next[documentId];
    next[documentId] = scrollTop;
    documentScrollTopsRef.current = pruneDocumentScrollTops(next);
    scheduleSave();
  }, [scheduleSave]);

  const getDocumentScrollTop = useCallback(
    (documentId: string) => documentScrollTopsRef.current[documentId] ?? 0,
    [],
  );

  return {
    workspaceDataReady,
    markWorkspaceDataReady: () => setWorkspaceDataReady(true),
    getDocumentScrollTop,
    rememberDocumentScrollTop,
  };
}
