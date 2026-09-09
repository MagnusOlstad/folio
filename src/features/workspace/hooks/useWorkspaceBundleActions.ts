import type { Dispatch, SetStateAction } from "react";
import type {
  BundleFile,
  FileMoveResult,
  Note,
  TabGroup,
  ViewerDocument,
} from "../../../domain/types.ts";
import { api } from "../../../lib/api.ts";
import { isUntitledId } from "../../../lib/workspace.ts";

type BundleActionState = {
  reindexing: boolean;
  groups: TabGroup[];
  files: BundleFile[];
  editingKey: string | null;
  movingFileId: string | null;
  savingDocuments: Set<string>;
  loadingDocuments: Set<string>;
};

type BundleActionSetters = {
  setReindexing: Dispatch<SetStateAction<boolean>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setFiles: Dispatch<SetStateAction<BundleFile[]>>;
  setDocuments: Dispatch<SetStateAction<Record<string, ViewerDocument>>>;
  setGroups: Dispatch<SetStateAction<TabGroup[]>>;
  setEditingKey: Dispatch<SetStateAction<string | null>>;
  clearDiscovery: () => void;
  setMovingFileId: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  setDraggedFileId: Dispatch<SetStateAction<string | null>>;
  setDropDirectoryPath: Dispatch<SetStateAction<string | null>>;
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
  } = state;
  const {
    setReindexing,
    setMessage,
    setNotes,
    setFiles,
    setDocuments,
    setGroups,
    setEditingKey,
    clearDiscovery,
    setMovingFileId,
    setDrafts,
    setExpandedDirectories,
    setDraggedFileId,
    setDropDirectoryPath,
  } = setters;

  async function reindexBundle() {
    if (reindexing) return;
    setReindexing(true);
    setMessage("");
    try {
      const result = await api<{
        notes: Note[];
        errors: { id: string; error: string }[];
      }>("/api/reindex", { method: "POST" });
      const refreshedFiles = await api<BundleFile[]>("/api/files");
      const openIds = Array.from(
        new Set(groups.flatMap((group) => group.tabs)),
      ).filter((id) => !isUntitledId(id));
      const refreshedDocuments = await Promise.allSettled(
        openIds.map(async (id) => ({
          oldId: id,
          document: await api<ViewerDocument>(
            `/api/file?path=${encodeURIComponent(id)}`,
          ),
        })),
      );
      const refreshedByOldId = new Map(
        refreshedDocuments.flatMap((refresh) =>
          refresh.status === "fulfilled"
            ? [[refresh.value.oldId, refresh.value.document] as const]
            : [],
        ),
      );
      setNotes(result.notes);
      setFiles(refreshedFiles);
      setDocuments((current) => {
        const next = { ...current };
        for (const [oldId, document] of refreshedByOldId) {
          if (document.id !== oldId) delete next[oldId];
          next[document.id] = document;
        }
        return next;
      });
      if (
        [...refreshedByOldId].some(([oldId, document]) => oldId !== document.id)
      ) {
        setGroups((current) =>
          current.map((group) => ({
            ...group,
            tabs: group.tabs.map((id) => refreshedByOldId.get(id)?.id || id),
            activeId: group.activeId
              ? refreshedByOldId.get(group.activeId)?.id || group.activeId
              : null,
          })),
        );
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
        result.errors.length
          ? `Reindexed with ${result.errors.length} invalid Markdown file${result.errors.length === 1 ? "" : "s"} skipped.`
          : `Reindexed ${result.notes.length} concepts.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not reindex the bundle",
      );
    } finally {
      setReindexing(false);
    }
  }

  async function moveBundleFile(id: string, directory: string) {
    const file = files.find((item) => item.id === id);
    const isEditing = groups.some(
      (group) => editingKey === `${group.id}:${id}`,
    );
    if (
      !file?.movable ||
      movingFileId ||
      file.directory === directory ||
      savingDocuments.has(id) ||
      loadingDocuments.has(id) ||
      isEditing
    )
      return;

    setMovingFileId(id);
    setMessage("");
    try {
      const result = await api<FileMoveResult>("/api/file/move", {
        method: "POST",
        body: JSON.stringify({ id, directory }),
      });
      const [notesResult, filesResult] = await Promise.allSettled([
        api<Note[]>("/api/notes"),
        api<BundleFile[]>("/api/files"),
      ]);

      setDocuments((current) => {
        const next = { ...current };
        delete next[result.oldId];
        next[result.newId] = result.note;
        return next;
      });
      setGroups((current) =>
        current.map((group) => {
          const tabs = group.tabs
            .map((tabId) => (tabId === result.oldId ? result.newId : tabId))
            .filter((tabId, index, allTabs) => allTabs.indexOf(tabId) === index);
          return {
            ...group,
            tabs,
            activeId:
              group.activeId === result.oldId ? result.newId : group.activeId,
          };
        }),
      );
      setDrafts((current) => {
        if (!(result.oldId in current)) return current;
        const next = { ...current };
        delete next[result.oldId];
        next[result.newId] = result.note.content;
        return next;
      });
      setNotes(
        notesResult.status === "fulfilled"
          ? notesResult.value
          : (current) =>
              current.map((note) =>
                note.id === result.oldId ? { ...note, ...result.note } : note,
              ),
      );
      setFiles(
        filesResult.status === "fulfilled"
          ? filesResult.value
          : (current) =>
              current.map((item) =>
                item.id === result.oldId
                  ? {
                      ...item,
                      id: result.newId,
                      name: result.newId.split("/").at(-1) || item.name,
                      directory,
                    }
                  : item,
              ),
      );
      setExpandedDirectories((current) => {
        const next = new Set(current).add("/");
        let path = "";
        for (const segment of directory.split("/").filter(Boolean)) {
          path += `/${segment}`;
          next.add(path);
        }
        return next;
      });
      clearDiscovery();
      setMessage(result.warning || `Moved ${file.title} to ${directory}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not move note");
    } finally {
      setMovingFileId(null);
      setDraggedFileId(null);
      setDropDirectoryPath(null);
    }
  }

  return { reindexBundle, moveBundleFile };
}
