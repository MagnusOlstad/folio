import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleFile, Note, SidebarMode, TabGroup, ViewerDocument } from "../../../domain/types.ts";
import {
  pruneDocumentScrollTops,
  reconcileWorkspaceSessionState,
  WORKSPACE_STATE_STORAGE_KEY,
  WORKSPACE_STATE_VERSION,
  pruneDocumentSelections,
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
  splitPosition: number;
  setGroups: React.Dispatch<React.SetStateAction<TabGroup[]>>;
  setActiveGroupId: React.Dispatch<React.SetStateAction<string>>;
  loadDocument: (id: string, source: "note" | "file") => Promise<void>;
  onLoadError?: (documentId: string, error: unknown) => void;
  bundleId: string;
  enabled?: boolean;
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
  splitPosition,
  setGroups,
  setActiveGroupId,
  loadDocument,
  onLoadError,
  bundleId,
  enabled = true,
}: UseWorkspaceSessionPersistenceOptions) {
  const [workspaceDataReady, setWorkspaceDataReady] = useState(initialState === null);
  const [workspaceRestored, setWorkspaceRestored] = useState(initialState === null);
  const documentScrollTopsRef = useRef<Record<string, number>>(
    initialState?.documentScrollTops ?? {},
  );
  const documentSelectionsRef = useRef<Record<string, { from: number; to: number }>>(
    initialState?.documentSelections ?? {},
  );
  const explorerScrollTopRef = useRef(initialState?.explorerScrollTop ?? 0);
  const latestStateRef = useRef<{
    groups: TabGroup[];
    activeGroupId: string;
    sidebarMode: SidebarMode;
    splitPosition: number;
  } | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const restoreStartedRef = useRef(false);
  const workspaceRestoredRef = useRef(workspaceRestored);
  const validIdsRef = useRef(new Set<string>());

  useEffect(() => {
    explorerScrollTopRef.current = explorerScrollTop;
    latestStateRef.current = { groups, activeGroupId, sidebarMode, splitPosition };
    workspaceRestoredRef.current = workspaceRestored;
    validIdsRef.current = new Set([
      ...Object.keys(documents),
      ...notes.map((note) => note.id),
      ...files.map((file) => file.id),
    ]);
  }, [activeGroupId, documents, explorerScrollTop, files, groups, notes, sidebarMode, splitPosition, workspaceRestored]);

  const save = useCallback(() => {
    const current = latestStateRef.current;
    if (!enabled || !workspaceRestoredRef.current || !current) return;
    const state = {
      ...current,
      explorerScrollTop: explorerScrollTopRef.current,
      documentScrollTops: pruneDocumentScrollTops(
        documentScrollTopsRef.current,
        validIdsRef.current,
      ),
      documentSelections: pruneDocumentSelections(
        documentSelectionsRef.current,
        validIdsRef.current,
      ),
    };
    writeStorageItem(
      `${WORKSPACE_STATE_STORAGE_KEY}:v2:${bundleId}`,
      JSON.stringify({ version: WORKSPACE_STATE_VERSION, ...state }),
    );
  }, [bundleId, enabled]);

  const snapshot = useCallback((): WorkspaceSessionState | null => {
    const current = latestStateRef.current;
    if (!current) return null;
    return {
      version: WORKSPACE_STATE_VERSION,
      ...current,
      explorerScrollTop: explorerScrollTopRef.current,
      documentScrollTops: pruneDocumentScrollTops(
        documentScrollTopsRef.current,
        validIdsRef.current,
      ),
      documentSelections: pruneDocumentSelections(
        documentSelectionsRef.current,
        validIdsRef.current,
      ),
    };
  }, []);

  const flush = useCallback(() => {
    const current = snapshot();
    save();
    return current;
  }, [save, snapshot]);

  const scheduleSave = useCallback(() => {
    if (!enabled || !workspaceRestored) return;
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      save();
    }, PERSIST_DEBOUNCE_MS);
  }, [enabled, save, workspaceRestored]);

  useEffect(() => {
    if (enabled && workspaceRestored) scheduleSave();
  }, [activeGroupId, bundleId, enabled, groups, scheduleSave, sidebarMode, splitPosition, workspaceRestored]);

  useEffect(() => {
    if (!enabled || !workspaceDataReady || workspaceRestored || restoreStartedRef.current || !initialState)
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
    documentSelectionsRef.current = pruneDocumentSelections(
      documentSelectionsRef.current,
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
  }, [activeGroupId, documents, enabled, files, groups, initialState, loadDocument, notes, onLoadError, setActiveGroupId, setGroups, workspaceDataReady, workspaceRestored]);

  useEffect(() => {
    const flush = () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (enabled) save();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [enabled, save]);

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

  const restoreDocumentScrollTops = useCallback((entries: Record<string, number>) => {
    documentScrollTopsRef.current = pruneDocumentScrollTops(entries);
  }, []);

  const rememberDocumentSelection = useCallback((documentId: string, from: number, to: number) => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return;
    const next = { ...documentSelectionsRef.current };
    delete next[documentId];
    next[documentId] = { from, to };
    documentSelectionsRef.current = pruneDocumentSelections(next);
    scheduleSave();
  }, [scheduleSave]);

  const getDocumentSelection = useCallback(
    (documentId: string) => documentSelectionsRef.current[documentId],
    [],
  );

  const restoreDocumentSelections = useCallback((entries: Record<string, { from: number; to: number }>) => {
    documentSelectionsRef.current = pruneDocumentSelections(entries);
  }, []);

  const skipInitialRestore = useCallback(() => {
    restoreStartedRef.current = true;
    workspaceRestoredRef.current = true;
    setWorkspaceDataReady(true);
    setWorkspaceRestored(true);
  }, []);

  return {
    workspaceDataReady,
    markWorkspaceDataReady: () => setWorkspaceDataReady(true),
    getDocumentScrollTop,
    rememberDocumentScrollTop,
    restoreDocumentScrollTops,
    getDocumentSelection,
    rememberDocumentSelection,
    restoreDocumentSelections,
    skipInitialRestore,
    snapshot,
    flush,
  };
}
