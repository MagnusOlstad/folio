import type { Dispatch, SetStateAction } from "react";
import type { BundleDirectory, BundleFile, Note, TabGroup, ViewerDocument } from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import type { ExplorerFileActions } from "../model/explorer.ts";
import type { NoteExportFormat } from "../model/note-export.ts";

type ExplorerActionOptions = {
  files: BundleFile[];
  groups: TabGroup[];
  editingKey: string | null;
  savingDocuments: Set<string>;
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
    files, groups, editingKey, savingDocuments,
    setFiles, setDirectories, setNotes, setDocuments, setDrafts, setGroups,
    setExpandedDirectories, setMessage, deleteFiledNote, exportFile, createNewTab,
  } = options;

  async function refreshExplorer() {
    try {
      const [nextFiles, nextDirectories, nextNotes] = await Promise.all([
        api<BundleFile[]>("/api/files"),
        api<BundleDirectory[]>("/api/directories"),
        api<Note[]>("/api/notes"),
      ]);
      setFiles(nextFiles);
      setDirectories(nextDirectories);
      setNotes(nextNotes);
      return true;
    } catch {
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
    setDocuments((current) => {
      const next = { ...current };
      delete next[oldId];
      next[newId] = note;
      return next;
    });
    setDrafts((current) => {
      if (!(oldId in current)) return current;
      const next = { ...current };
      delete next[oldId];
      next[newId] = note.content;
      return next;
    });
    setGroups((current) => current.map((group) => ({
      ...group,
      tabs: group.tabs.map((id) => id === oldId ? newId : id),
      activeId: group.activeId === oldId ? newId : group.activeId,
      previewId: group.previewId === oldId ? newId : group.previewId,
    })));
  }

  async function renameFile(id: string, name: string) {
    const file = files.find((item) => item.id === id);
    const editing = groups.some((group) => editingKey === `${group.id}:${id}`);
    if (!file?.movable || savingDocuments.has(id) || editing)
      throw new Error("Finish editing this file before renaming it.");
    setMessage("");
    const result = await api<{ oldId: string; newId: string; note: ViewerDocument; warning: string | null }>(
      "/api/file/rename",
      { method: "POST", body: JSON.stringify({ id, name }) },
    );
    reconcileRenamedFile(result.oldId, result.newId, result.note);
    ensureExpanded(result.newId.slice(0, result.newId.lastIndexOf("/")) || "/");
    if (await refreshExplorer())
      setMessage(result.warning || `Renamed ${file.name} to ${result.newId.split("/").at(-1)}.`);
  }

  async function createFile(directory: string) {
    ensureExpanded(directory);
    createNewTab(`path: ${directory}\n`);
  }

  async function createDirectory(directory: string, name: string) {
    const result = await api<{ path: string }>("/api/file/folder", {
      method: "POST",
      body: JSON.stringify({ directory, name }),
    });
    const refreshed = await refreshExplorer();
    ensureExpanded(result.path);
    if (refreshed) setMessage(`Created folder ${result.path.split("/").at(-1)}.`);
  }

  async function deleteFile(file: BundleFile) {
    if (!file.deletable || !file.movable) throw new Error("This fixed OKF file cannot be deleted.");
    await deleteFiledNote(file);
    await refreshExplorer();
  }

  async function deleteDirectory(directory: string) {
    setMessage("");
    await api<{ path: string }>(`/api/file/folder?path=${encodeURIComponent(directory)}`, { method: "DELETE" });
    setExpandedDirectories((current) => new Set(
      [...current].filter((path) => path !== directory && !path.startsWith(`${directory}/`)),
    ));
    if (await refreshExplorer()) setMessage(`Deleted folder ${directory.split("/").at(-1)}.`);
  }

  async function copyText(value: string) {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await navigator.clipboard.writeText(value);
    setMessage("Copied path to clipboard.");
  }

  const actions: ExplorerFileActions = {
    renameFile,
    createFile,
    createDirectory,
    deleteFile,
    deleteDirectory,
    exportFile,
    copyText,
  };
  return actions;
}
