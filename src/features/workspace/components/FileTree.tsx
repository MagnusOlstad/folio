import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent } from "react";
import type { BundleFile, TreeDirectory } from "../../../domain/types.ts";
import type { ExplorerContextTarget } from "../model/explorer.ts";

const EXPLORER_TITLE_LIMIT = 48;

function explorerTitle(title: string) {
  const characters = Array.from(title);
  return characters.length <= EXPLORER_TITLE_LIMIT
    ? title
    : `${characters.slice(0, EXPLORER_TITLE_LIMIT - 1).join("")}…`;
}

type FileTreeProps = {
  directory: TreeDirectory;
  depth: number;
  hideRoot?: boolean;
  expanded: Set<string>;
  draggedFileId: string | null;
  dropDirectoryPath: string | null;
  movingFileId: string | null;
  blockedFileIds: Set<string>;
  activeFileId?: string | null;
  onToggle: (path: string) => void;
  onOpen: (id: string, disposition: "preview" | "permanent") => void;
  onFileDragStart: (id: string) => void;
  onFileDragEnd: () => void;
  onDirectoryDragOver: (path: string | null) => void;
  onMove: (id: string, directory: string) => void;
  onContextMenu?: (target: ExplorerContextTarget, x: number, y: number, anchor: HTMLElement) => void;
};
type TreeContext = Omit<FileTreeProps, "directory" | "depth" | "hideRoot">;

function directoryDropHandlers(
  path: string,
  draggedFileId: string | null,
  onDirectoryDragOver: FileTreeProps["onDirectoryDragOver"],
  onFileDragEnd: FileTreeProps["onFileDragEnd"],
  onMove: FileTreeProps["onMove"],
) {
  return {
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!draggedFileId && !event.dataTransfer.types.includes("application/x-folio-file")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      onDirectoryDragOver(path);
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) onDirectoryDragOver(null);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      event.preventDefault();
      event.stopPropagation();
      const fileId = event.dataTransfer.getData("application/x-folio-file") || draggedFileId;
      if (fileId) onMove(fileId, path);
      onFileDragEnd();
    },
  };
}

function openDirectoryMenu(
  directory: TreeDirectory,
  onContextMenu: FileTreeProps["onContextMenu"],
  element: HTMLElement,
  x: number,
  y: number,
) {
  onContextMenu?.({ kind: "directory", path: directory.path }, x, y, element);
}

function directoryMenuHandlers(
  directory: TreeDirectory,
  onContextMenu: FileTreeProps["onContextMenu"],
) {
  return {
    "aria-haspopup": onContextMenu ? "menu" as const : undefined,
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault();
      event.stopPropagation();
      openDirectoryMenu(directory, onContextMenu, event.currentTarget, event.clientX, event.clientY);
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openDirectoryMenu(directory, onContextMenu, event.currentTarget, bounds.left, bounds.bottom);
    },
  };
}

function TreeFileRow({ file, depth, tree }: { file: BundleFile; depth: number; tree: TreeContext }) {
  const { draggedFileId, movingFileId, blockedFileIds, onOpen, onFileDragStart, onFileDragEnd, onContextMenu } = tree;
  const active = tree.activeFileId === file.id;
  function openMenu(element: HTMLElement, x: number, y: number) {
    onContextMenu?.({ kind: "file", path: file.id, file }, x, y, element);
  }
  function handleContextMenu(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    openMenu(event.currentTarget, event.clientX, event.clientY);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    openMenu(event.currentTarget, bounds.left, bounds.bottom);
  }

  return (
    <button
      type="button"
      className={`tree-row tree-file ${active ? "active" : ""} ${draggedFileId === file.id ? "dragging" : ""} ${movingFileId === file.id ? "moving" : ""}`}
      style={{ "--tree-depth": depth } as CSSProperties}
      onClick={() => onOpen(file.id, "preview")}
      onDoubleClick={() => onOpen(file.id, "permanent")}
      draggable={file.movable && !blockedFileIds.has(file.id) && movingFileId !== file.id}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-folio-file", file.id);
        onFileDragStart(file.id);
      }}
      onDragEnd={onFileDragEnd}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      aria-label={file.title}
      aria-current={active ? "true" : undefined}
      data-file-id={file.id}
      aria-haspopup={onContextMenu ? "menu" : undefined}
      title={file.movable ? `${file.title} - drag onto a folder to move` : `${file.title} - fixed OKF path`}
    >
      <span className="tree-file-mark">M</span>
      <span>{explorerTitle(file.title)}</span>
    </button>
  );
}

function TreeDirectoryRow({ directory, depth, tree }: { directory: TreeDirectory; depth: number; tree: TreeContext }) {
  const isExpanded = tree.expanded.has(directory.path);
  const dropHandlers = directoryDropHandlers(
    directory.path,
    tree.draggedFileId,
    tree.onDirectoryDragOver,
    tree.onFileDragEnd,
    tree.onMove,
  );
  return (
    <div className="tree-branch">
      <button
        type="button"
        className={`tree-row tree-directory ${tree.dropDirectoryPath === directory.path ? "drop-target" : ""}`}
        style={{ "--tree-depth": depth } as CSSProperties}
        onClick={() => tree.onToggle(directory.path)}
        {...dropHandlers}
        {...directoryMenuHandlers(directory, tree.onContextMenu)}
        aria-expanded={isExpanded}
      >
        <span className="tree-chevron">{isExpanded ? "v" : ">"}</span>
        <span className="tree-folder" aria-hidden="true" />
        <span>{directory.name}</span>
      </button>
      {isExpanded ? <TreeChildren directory={directory} depth={depth + 1} tree={tree} /> : null}
    </div>
  );
}

function TreeChildren({ directory, depth, tree }: { directory: TreeDirectory; depth: number; tree: TreeContext }) {
  return (
    <div>
      {directory.directories.map((child) => (
        <TreeDirectoryRow key={child.path} directory={child} depth={depth} tree={tree} />
      ))}
      {directory.files.map((file) => (
        <TreeFileRow key={file.id} file={file} depth={depth} tree={tree} />
      ))}
    </div>
  );
}

export function FileTree({ directory, depth, hideRoot = false, ...tree }: FileTreeProps) {
  if (hideRoot) {
    return (
      <div
        className={`tree-branch${tree.dropDirectoryPath === directory.path ? " drop-target" : ""}`}
        {...directoryDropHandlers(directory.path, tree.draggedFileId, tree.onDirectoryDragOver, tree.onFileDragEnd, tree.onMove)}
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          openDirectoryMenu(directory, tree.onContextMenu, event.currentTarget, event.clientX, event.clientY);
        }}
      >
        <TreeChildren directory={directory} depth={depth} tree={tree} />
      </div>
    );
  }
  return <TreeDirectoryRow directory={directory} depth={depth} tree={tree} />;
}
