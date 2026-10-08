import { useLayoutEffect, useRef } from "react";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { BundleDirectory, BundleFile, Note, TabGroup, ViewerDocument } from "../../../domain/types.ts";
import { apiForBundle, getActiveBundleId, getActiveBundleRevision } from "../../../lib/api.ts";
import { canDeleteExplorerDirectory, isExplorerDescendant, type ExplorerFileActions } from "../model/explorer.ts";
import type { NoteExportFormat } from "../model/note-export.ts";
import { replaceDocumentPath, replaceDocumentTabs } from "../model/document-path.ts";

type ExplorerActionOptions = {
  files: BundleFile[];
  groups: TabGroup[];
  editingKey: string | null;
  savingDocuments: Set<string>;
  loadingDocuments: Set<string>;
  movingFileId: string | null;
  documentRequests: RefObject<Record<string, number>>;
  documentsRef: RefObject<Record<string, ViewerDocument>>;
  draftsRef: RefObject<Record<string, string>>;
  deletingDirectories: RefObject<Set<string>>;
  directoryDeletions: RefObject<Record<string, number>>;
  documentMutationSequence: RefObject<number>;
  recordDocumentPathChange: (oldId: string, newId: string | null) => void;
  recordExplorerMutation: () => void;
  isDocumentDirty: (id: string) => boolean;
  removeDiscoveryDirectory: (directory: string) => void;
  setLoadingDocuments: Dispatch<SetStateAction<Set<string>>>;
  setEditingKey: Dispatch<SetStateAction<string | null>>;
  setMovingFileId: Dispatch<SetStateAction<string | null>>;
  setFiles: Dispatch<SetStateAction<BundleFile[]>>;
  setDirectories: Dispatch<SetStateAction<BundleDirectory[]>>;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setDocuments: Dispatch<SetStateAction<Record<string, ViewerDocument>>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setGroups: Dispatch<SetStateAction<TabGroup[]>>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  setMessage: (message: string) => void;
  deleteFiledNote: (file: Pick<BundleFile, "id" | "title" | "deletable">) => Promise<void>;
  exportFile: (file: BundleFile, format: NoteExportFormat) => Promise<void>;
  createNewTab: (initialContent?: string) => void;
};

export function useWorkspaceExplorerActions(options: ExplorerActionOptions): ExplorerFileActions {
  const {
    files, groups, editingKey, savingDocuments, loadingDocuments, movingFileId, documentRequests, documentsRef, draftsRef,
    deletingDirectories, directoryDeletions, documentMutationSequence, recordDocumentPathChange, recordExplorerMutation, isDocumentDirty, removeDiscoveryDirectory, setLoadingDocuments, setEditingKey,
    setFiles, setDirectories, setNotes, setDocuments, setDrafts, setGroups,
    setExpandedDirectories, setMessage, deleteFiledNote, exportFile, createNewTab, setMovingFileId,
  } = options;

  const pendingAction = useRef<number | null>(null);
  const latest = useRef({ savingDocuments, movingFileId, editingKey, groups });
  useLayoutEffect(() => { latest.current = { savingDocuments, movingFileId, editingKey, groups }; },
    [savingDocuments, movingFileId, editingKey, groups]);

  async function refreshExplorer(bundleId = getActiveBundleId(), revision = getActiveBundleRevision()) {
    const mutationSequence = documentMutationSequence.current;
    try {
      const [nextFiles, nextDirectories, nextNotes] = await Promise.all([
        apiForBundle<BundleFile[]>(bundleId, "/api/files"),
        apiForBundle<BundleDirectory[]>(bundleId, "/api/directories"),
        apiForBundle<Note[]>(bundleId, "/api/notes"),
      ]);
      if (getActiveBundleRevision() !== revision || documentMutationSequence.current !== mutationSequence) return false;
      setFiles(nextFiles);
      setDirectories(nextDirectories);
      setNotes(nextNotes);
      return true;
    } catch {
      if (getActiveBundleRevision() !== revision || documentMutationSequence.current !== mutationSequence) return false;
      setMessage("The change succeeded, but the explorer could not be refreshed. Reload the bundle to see it.");
      return false;
    }
  }

  function ensureExpanded(directory: string) {
    setExpandedDirectories((current) => {
      const next = new Set(current).add("/");
      let currentPath = "";
      for (const segment of directory.split("/").filter(Boolean)) {
        currentPath += `/${segment}`;
        next.add(currentPath);
      }
      return next;
    });
  }

  function reconcileRenamedFile(oldId: string, newId: string, note: ViewerDocument) {
    recordDocumentPathChange(oldId, newId);
    documentsRef.current = replaceDocumentPath(documentsRef.current, oldId, newId, note);
    draftsRef.current = replaceDocumentPath(draftsRef.current, oldId, newId);
    setDocuments((current) => replaceDocumentPath(current, oldId, newId, note));
    setDrafts((current) => replaceDocumentPath(current, oldId, newId));
    setGroups((current) => replaceDocumentTabs(current, oldId, newId));
    setLoadingDocuments((current) => new Set([...current].filter((id) => id !== oldId && id !== newId)));
  }

  async function renameFile(id: string, name: string) {
    const file = files.find((item) => item.id === id);
    const editing = groups.some((group) => editingKey === `${group.id}:${id}`);
    if (!file?.movable || savingDocuments.has(id) || loadingDocuments.has(id) || movingFileId || editing || isDocumentDirty(id))
      throw new Error("Finish editing this file before renaming it.");
    if ([...deletingDirectories.current].some((path) => isExplorerDescendant(id, path))) return;
    setMessage("");
    const bundleId = getActiveBundleId();
    const revision = getActiveBundleRevision();
    setMovingFileId(id);
    try {
      const result = await apiForBundle<{ oldId: string; newId: string; note: ViewerDocument; warning: string | null }>(
        bundleId, "/api/file/rename",
        { method: "POST", body: JSON.stringify({ id, name }) },
      );
      if (getActiveBundleRevision() !== revision) return;
      reconcileRenamedFile(result.oldId, result.newId, result.note);
      setFiles((current) => current.map((item) => item.id === result.oldId
        ? { ...item, id: result.newId, name: result.newId.split("/").at(-1) || item.name, title: result.note.title, directory: result.newId.slice(0, result.newId.lastIndexOf("/")) || "/" }
        : item));
      setNotes((current) => current.map((item) => item.id === result.oldId ? { ...item, ...result.note } : item));
      ensureExpanded(result.newId.slice(0, result.newId.lastIndexOf("/")) || "/");
      if (await refreshExplorer(bundleId, revision))
        setMessage(result.warning || `Renamed ${file.name} to ${result.newId.split("/").at(-1)}.`);
    } catch (error) {
      if (getActiveBundleRevision() === revision) throw error;
    } finally {
      if (getActiveBundleRevision() === revision) setMovingFileId(null);
    }
  }

  async function createFile(directory: string) {
    ensureExpanded(directory);
    createNewTab(`path: ${directory}\n`);
  }

  async function createDirectory(directory: string, name: string) {
    const bundleId = getActiveBundleId();
    const revision = getActiveBundleRevision();
    const result = await apiForBundle<{ path: string }>(bundleId, "/api/file/folder", {
      method: "POST",
      body: JSON.stringify({ directory, name }),
    });
    if (getActiveBundleRevision() !== revision) return;
    recordExplorerMutation();
    const refreshed = await refreshExplorer(bundleId, revision);
    if (getActiveBundleRevision() !== revision) return;
    ensureExpanded(result.path);
    if (refreshed) setMessage(`Created folder ${result.path.split("/").at(-1)}.`);
  }

  async function deleteFile(file: BundleFile) {
    if (!file.deletable || !file.movable) throw new Error("This fixed OKF file cannot be deleted.");
    if (isDocumentDirty(file.id)) throw new Error("Finish saving this file before deleting it.");
    const bundleId = getActiveBundleId();
    const revision = getActiveBundleRevision();
    await deleteFiledNote(file);
    if (getActiveBundleRevision() === revision) await refreshExplorer(bundleId, revision);
  }

  async function deleteDirectory(directory: string) {
    if (!canDeleteExplorerDirectory(directory)) throw new Error("This system folder cannot be deleted.");
    const { savingDocuments, movingFileId, editingKey, groups } = latest.current;
    const contains = (id: string) => isExplorerDescendant(id, directory);
    const knownIds = new Set([
      ...files.map((file) => file.id), ...groups.flatMap((group) => group.tabs),
      ...Object.keys(documentsRef.current), ...Object.keys(draftsRef.current),
      ...Object.keys(documentRequests.current), ...savingDocuments,
    ]);
    const editingId = groups.map((group) => editingKey?.startsWith(`${group.id}:`)
      ? editingKey.slice(group.id.length + 1) : null).find((id) => id && contains(id));
    if (editingId || (movingFileId && contains(movingFileId))
      || [...knownIds].some((id) => contains(id) && (savingDocuments.has(id) || isDocumentDirty(id))))
      throw new Error("Finish editing, saving, or moving files in this folder before deleting it.");
    const bundleId = getActiveBundleId();
    const revision = getActiveBundleRevision();
    const pendingDirectories = deletingDirectories.current;
    pendingDirectories.add(directory);
    setMessage("");
    try {
      const result = await apiForBundle<{ path: string; deletedIds: string[]; warning: string | null }>(
        bundleId, `/api/file/folder?path=${encodeURIComponent(directory)}`, { method: "DELETE" },
      );
      if (getActiveBundleRevision() !== revision) return;
      directoryDeletions.current[directory] = ++documentMutationSequence.current;
      // Invalidate in-flight loads using monotonically increasing tokens. A
      // future note at the same path must never accept an older response.
      for (const id of Object.keys(documentRequests.current)) {
        if (contains(id)) documentRequests.current[id] += 1;
      }
      const withoutDescendants = <T,>(current: Record<string, T>) => Object.fromEntries(
        Object.entries(current).filter(([id]) => !contains(id)),
      );
      documentsRef.current = withoutDescendants(documentsRef.current);
      draftsRef.current = withoutDescendants(draftsRef.current);
      setDocuments(withoutDescendants);
      setDrafts(withoutDescendants);
      setLoadingDocuments((current) => new Set([...current].filter((id) => !contains(id))));
      setFiles((current) => current.filter((file) => !contains(file.id)));
      setDirectories((current) => current.filter((folder) => !contains(folder.path)));
      setNotes((current) => current.filter((note) => !contains(note.id)));
      setGroups((current) => current.map((group) => {
        const activeIndex = group.activeId ? group.tabs.indexOf(group.activeId) : 0;
        const tabs = group.tabs.filter((id) => !contains(id));
        return {
          ...group, tabs,
          activeId: group.activeId && contains(group.activeId)
            ? tabs[Math.min(activeIndex, tabs.length - 1)] || null : group.activeId,
          previewId: group.previewId && contains(group.previewId) ? null : group.previewId,
        };
      }));
      setExpandedDirectories((current) => new Set([...current].filter((path) => !contains(path))));
      setEditingKey((current) => {
        const group = groups.find((item) => current?.startsWith(`${item.id}:`));
        return group && current && contains(current.slice(group.id.length + 1)) ? null : current;
      });
      removeDiscoveryDirectory(directory);
      if (await refreshExplorer(bundleId, revision)) setMessage(result.warning || `Deleted folder ${directory.split("/").at(-1)}.`);
      else if (result.warning && getActiveBundleRevision() === revision) setMessage(`${result.warning} The explorer could not be refreshed.`);
    } finally {
      pendingDirectories.delete(directory);
    }
  }

  async function copyText(value: string) {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await navigator.clipboard.writeText(value);
    setMessage("Copied path to clipboard.");
  }

  async function exclusive(action: () => Promise<void>) {
    const revision = getActiveBundleRevision();
    if (pendingAction.current === revision) return;
    pendingAction.current = revision;
    try { await action(); }
    catch (error) { if (getActiveBundleRevision() === revision) throw error; }
    finally { if (pendingAction.current === revision) pendingAction.current = null; }
  }

  const actions: ExplorerFileActions = {
    renameFile: (id, name) => exclusive(() => renameFile(id, name)),
    createFile: (directory) => exclusive(() => createFile(directory)),
    createDirectory: (directory, name) => exclusive(() => createDirectory(directory, name)),
    deleteFile: (file) => exclusive(() => deleteFile(file)),
    deleteDirectory: (directory) => exclusive(() => deleteDirectory(directory)),
    exportFile: (file, format) => exclusive(() => exportFile(file, format)),
    copyText: (value) => exclusive(() => copyText(value)),
  };
  return actions;
}
