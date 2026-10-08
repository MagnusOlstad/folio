import { useLayoutEffect, useRef } from "react";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type {
  BundleFile,
  BundleDirectory,
  FileMoveResult,
  Note,
  TabGroup,
  ViewerDocument,
} from "../../../domain/types.ts";
import { apiForBundle, getActiveBundleId, getActiveBundleRevision } from "../../../lib/api.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import { replaceDocumentPath, replaceDocumentTabs } from "../model/document-path.ts";

type BundleActionState = {
  reindexing: boolean;
  groups: TabGroup[];
  files: BundleFile[];
  editingKey: string | null;
  movingFileId: string | null;
  savingDocuments: Set<string>;
  loadingDocuments: Set<string>;
  deletingDirectories?: RefObject<Set<string>>;
  documentsRef: RefObject<Record<string, ViewerDocument>>;
  draftsRef: RefObject<Record<string, string>>;
  documentRequests: RefObject<Record<string, number>>;
  documentPathChanges: RefObject<Record<string, { sequence: number; newId: string | null }>>;
  documentMutationSequence: RefObject<number>;
  recordDocumentPathChange: (oldId: string, newId: string | null) => void;
  isDocumentDirty: (id: string) => boolean;
};

type BundleActionSetters = {
  setReindexing: Dispatch<SetStateAction<boolean>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setFiles: Dispatch<SetStateAction<BundleFile[]>>;
  setDirectories: Dispatch<SetStateAction<BundleDirectory[]>>;
  setDocuments: Dispatch<SetStateAction<Record<string, ViewerDocument>>>;
  setGroups: Dispatch<SetStateAction<TabGroup[]>>;
  setEditingKey: Dispatch<SetStateAction<string | null>>;
  clearDiscovery: () => void;
  setMovingFileId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  setDraggedFileId: Dispatch<SetStateAction<string | null>>;
  setDropDirectoryPath: Dispatch<SetStateAction<string | null>>;
  setLoadingDocuments: Dispatch<SetStateAction<Set<string>>>;
};

export function useWorkspaceBundleActions(
  state: BundleActionState,
  setters: BundleActionSetters,
) {
  const {
    reindexing,
    groups,
    files,
    editingKey,
    movingFileId,
    savingDocuments,
    loadingDocuments,
    deletingDirectories,
    documentsRef,
    draftsRef,
    documentRequests,
    documentPathChanges,
    documentMutationSequence,
    recordDocumentPathChange,
    isDocumentDirty,
  } = state;
  const {
    setReindexing,
    setMessage,
    setNotes,
    setFiles,
    setDirectories,
    setDocuments,
    setGroups,
    setEditingKey,
    clearDiscovery,
    setMovingFileId,
    setDrafts,
    setExpandedDirectories,
    setDraggedFileId,
    setDropDirectoryPath,
    setLoadingDocuments,
  } = setters;
  const pendingReindex = useRef<number | null>(null);
  const pendingMove = useRef<number | null>(null);
  const latest = useRef(state);
  useLayoutEffect(() => { latest.current = state; }, [state]);

  async function reindexBundle() {
    const bundleId = getActiveBundleId();
    const revision = getActiveBundleRevision();
    if (reindexing || pendingReindex.current === revision || movingFileId) return;
    pendingReindex.current = revision;
    const isCurrent = () => getActiveBundleRevision() === revision;
    const reindexMutationSequence = documentMutationSequence.current;
    setReindexing(true);
    setMessage("");
    try {
      const result = await apiForBundle<{
        notes: Note[];
        errors: { id: string; error: string }[];
      }>(bundleId, "/api/reindex", { method: "POST" });
      if (!isCurrent()) return;
      const [refreshedFiles, refreshedDirectories] = await Promise.allSettled([
        apiForBundle<BundleFile[]>(bundleId, "/api/files"),
        apiForBundle<BundleDirectory[]>(bundleId, "/api/directories"),
      ]);
      if (!isCurrent()) return;
      const openIds = Array.from(
        new Set(groups.flatMap((group) => group.tabs)),
      ).filter((id) => !isUntitledId(id));
      const beforeRefresh = documentsRef.current;
      const beforeRequests = { ...documentRequests.current };
      const mutationSequence = documentMutationSequence.current;
      const refreshedDocuments = await Promise.allSettled(
        openIds.map(async (id) => ({
          oldId: id,
          document: await apiForBundle<ViewerDocument>(
            bundleId, `/api/file?path=${encodeURIComponent(id)}`,
          ),
        })),
      );
      if (!isCurrent()) return;
      if (documentMutationSequence.current !== reindexMutationSequence) {
        setMessage("Reindexed the bundle. Files changed during the refresh; the newer explorer state was retained.");
        return;
      }
      const refreshedByOldId = new Map(
        refreshedDocuments.flatMap((refresh) =>
          refresh.status === "fulfilled" && !latest.current.isDocumentDirty(refresh.value.oldId)
            && !latest.current.isDocumentDirty(refresh.value.document.id)
            && !latest.current.savingDocuments.has(refresh.value.oldId)
            && !latest.current.savingDocuments.has(refresh.value.document.id)
            && !latest.current.movingFileId
            && documentsRef.current[refresh.value.oldId] === beforeRefresh[refresh.value.oldId]
            && documentsRef.current[refresh.value.document.id] === beforeRefresh[refresh.value.document.id]
            && documentRequests.current[refresh.value.oldId] === beforeRequests[refresh.value.oldId]
            && documentRequests.current[refresh.value.document.id] === beforeRequests[refresh.value.document.id]
            && (documentPathChanges.current[refresh.value.document.id]?.sequence ?? 0) <= mutationSequence
            ? [[refresh.value.oldId, refresh.value.document] as const]
            : [],
        ),
      );
      setNotes(result.notes);
      if (refreshedFiles.status === "fulfilled") setFiles(refreshedFiles.value);
      if (refreshedDirectories.status === "fulfilled") setDirectories(refreshedDirectories.value);
      const reconcileDocuments = (current: Record<string, ViewerDocument>) => {
        const next = { ...current };
        for (const [oldId, document] of refreshedByOldId) {
          if (document.id !== oldId) delete next[oldId];
          next[document.id] = document;
        }
        return next;
      };
      documentsRef.current = reconcileDocuments(documentsRef.current);
      setDocuments(reconcileDocuments);
      if (
        [...refreshedByOldId].some(([oldId, document]) => oldId !== document.id)
      ) {
        const reconcileDrafts = (current: Record<string, string>) => {
          let next = current;
          for (const [oldId, document] of refreshedByOldId) {
            if (oldId !== document.id) next = replaceDocumentPath(next, oldId, document.id);
          }
          return next;
        };
        draftsRef.current = reconcileDrafts(draftsRef.current);
        setDrafts(reconcileDrafts);
        setGroups((current) => {
          let next = current;
          for (const [oldId, document] of refreshedByOldId) next = replaceDocumentTabs(next, oldId, document.id);
          return next;
        });
        setEditingKey((current) => {
          if (!current) return current;
          const group = groups.find(({ id }) => current.startsWith(`${id}:`));
          if (!group) return current;
          const documentId = current.slice(group.id.length + 1);
          const refreshed = refreshedByOldId.get(documentId);
          return refreshed ? `${group.id}:${refreshed.id}` : current;
        });
      }
      clearDiscovery();
      setMessage(
        refreshedFiles.status === "rejected" || refreshedDirectories.status === "rejected"
          ? "Reindexed the bundle, but the explorer could not be refreshed. Reload the bundle to see it."
          : result.errors.length
          ? `Reindexed with ${result.errors.length} invalid Markdown file${result.errors.length === 1 ? "" : "s"} skipped.`
          : `Reindexed ${result.notes.length} concepts.`,
      );
    } catch (error) {
      if (!isCurrent()) return;
      setMessage(
        error instanceof Error ? error.message : "Could not reindex the bundle",
      );
    } finally {
      if (pendingReindex.current === revision) pendingReindex.current = null;
      if (isCurrent()) setReindexing(false);
    }
  }

  async function moveBundleFile(id: string, directory: string) {
    const revision = getActiveBundleRevision();
    if ([...(deletingDirectories?.current || [])].some((path) => id.startsWith(`${path}/`) || directory === path || directory.startsWith(`${path}/`))) return;
    const file = files.find((item) => item.id === id);
    const isEditing = groups.some(
      (group) => editingKey === `${group.id}:${id}`,
    );
    if (
      !file?.movable ||
      movingFileId ||
      pendingMove.current === revision ||
      reindexing ||
      pendingReindex.current === revision ||
      file.directory === directory ||
      savingDocuments.has(id) ||
      loadingDocuments.has(id) ||
      isEditing
      || isDocumentDirty(id)
    )
      return;

    pendingMove.current = revision;
    const bundleId = getActiveBundleId();
    const isCurrent = () => getActiveBundleRevision() === revision;
    setMovingFileId(id);
    setMessage("");
    try {
      const result = await apiForBundle<FileMoveResult>(bundleId, "/api/file/move", {
        method: "POST",
        body: JSON.stringify({ id, directory }),
      });
      if (!isCurrent()) return;
      recordDocumentPathChange(result.oldId, result.newId);
      const mutationSequence = documentMutationSequence.current;
      const destinationDirectory = result.newId.slice(0, result.newId.lastIndexOf("/")) || "/";
      documentsRef.current = replaceDocumentPath(documentsRef.current, result.oldId, result.newId, result.note);
      draftsRef.current = replaceDocumentPath(draftsRef.current, result.oldId, result.newId);
      setDocuments((current) => replaceDocumentPath(current, result.oldId, result.newId, result.note));
      setDrafts((current) => replaceDocumentPath(current, result.oldId, result.newId));
      setGroups((current) => replaceDocumentTabs(current, result.oldId, result.newId));
      setLoadingDocuments((current) => new Set([...current].filter((id) => id !== result.oldId && id !== result.newId)));
      setNotes((current) => current.map((note) => note.id === result.oldId ? { ...note, ...result.note } : note));
      setFiles((current) => current.map((item) => item.id === result.oldId
        ? { ...item, id: result.newId, name: result.newId.split("/").at(-1) || item.name, title: result.note.title, directory: destinationDirectory }
        : item));
      const destinationPaths: string[] = [];
      let destinationPath = "";
      for (const segment of destinationDirectory.split("/").filter(Boolean)) {
        destinationPath += `/${segment}`;
        destinationPaths.push(destinationPath);
      }
      setDirectories((current) => [
        ...current,
        ...destinationPaths.filter((path) => !current.some((folder) => folder.path === path)).map((path) => ({ path })),
      ]);
      setExpandedDirectories((current) => new Set([...current, "/", ...destinationPaths]));
      clearDiscovery();
      setMessage(result.warning || `Moved ${file.title} to ${destinationDirectory}.`);
      const [notesResult, filesResult, directoriesResult] = await Promise.allSettled([
        apiForBundle<Note[]>(bundleId, "/api/notes"),
        apiForBundle<BundleFile[]>(bundleId, "/api/files"),
        apiForBundle<BundleDirectory[]>(bundleId, "/api/directories"),
      ]);
      if (!isCurrent() || documentMutationSequence.current !== mutationSequence) return;
      if (notesResult.status === "fulfilled") setNotes(notesResult.value);
      if (filesResult.status === "fulfilled") setFiles(filesResult.value);
      if (directoriesResult.status === "fulfilled") setDirectories(directoriesResult.value);
    } catch (error) {
      if (!isCurrent()) return;
      setMessage(error instanceof Error ? error.message : "Could not move note");
    } finally {
      if (pendingMove.current === revision) pendingMove.current = null;
      if (isCurrent()) {
        setMovingFileId(null);
        setDraggedFileId(null);
        setDropDirectoryPath(null);
      }
    }
  }

  return { reindexBundle, moveBundleFile };
}
