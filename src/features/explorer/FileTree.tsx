import type { TreeDirectory } from "../../domain/types.ts";

const EXPLORER_TITLE_LIMIT = 48;

function explorerTitle(title: string) {
  const characters = Array.from(title);
  return characters.length <= EXPLORER_TITLE_LIMIT
    ? title
    : `${characters.slice(0, EXPLORER_TITLE_LIMIT - 1).join("")}…`;
}

export function FileTree({
  directory,
  depth,
  expanded,
  draggedFileId,
  dropDirectoryPath,
  movingFileId,
  blockedFileIds,
  onToggle,
  onOpen,
  onFileDragStart,
  onFileDragEnd,
  onDirectoryDragOver,
  onMove,
}: {
  directory: TreeDirectory;
  depth: number;
  expanded: Set<string>;
  draggedFileId: string | null;
  dropDirectoryPath: string | null;
  movingFileId: string | null;
  blockedFileIds: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (id: string) => void;
  onFileDragStart: (id: string) => void;
  onFileDragEnd: () => void;
  onDirectoryDragOver: (path: string | null) => void;
  onMove: (id: string, directory: string) => void;
}) {
  const isExpanded = expanded.has(directory.path);
  return (
    <div className="tree-branch">
      <button
        type="button"
        className={`tree-row tree-directory ${dropDirectoryPath === directory.path ? "drop-target" : ""}`}
        style={{ "--tree-depth": depth } as React.CSSProperties}
        onClick={() => onToggle(directory.path)}
        onDragOver={(event) => {
          if (
            !draggedFileId &&
            !event.dataTransfer.types.includes("application/x-folio-file")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          onDirectoryDragOver(directory.path);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            onDirectoryDragOver(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const fileId =
            event.dataTransfer.getData("application/x-folio-file") ||
            draggedFileId;
          if (fileId) onMove(fileId, directory.path);
          onFileDragEnd();
        }}
        aria-expanded={isExpanded}
      >
        <span className="tree-chevron">{isExpanded ? "v" : ">"}</span>
        <span className="tree-folder" aria-hidden="true" />
        <span>{directory.name}</span>
      </button>
      {isExpanded ? (
        <div>
          {directory.directories.map((child) => (
            <FileTree
              key={child.path}
              directory={child}
              depth={depth + 1}
              expanded={expanded}
              draggedFileId={draggedFileId}
              dropDirectoryPath={dropDirectoryPath}
              movingFileId={movingFileId}
              blockedFileIds={blockedFileIds}
              onToggle={onToggle}
              onOpen={onOpen}
              onFileDragStart={onFileDragStart}
              onFileDragEnd={onFileDragEnd}
              onDirectoryDragOver={onDirectoryDragOver}
              onMove={onMove}
            />
          ))}
          {directory.files.map((file) => (
            <button
              type="button"
              className={`tree-row tree-file ${draggedFileId === file.id ? "dragging" : ""} ${movingFileId === file.id ? "moving" : ""}`}
              style={{ "--tree-depth": depth + 1 } as React.CSSProperties}
              onClick={() => onOpen(file.id)}
              draggable={
                file.movable &&
                !blockedFileIds.has(file.id) &&
                movingFileId !== file.id
              }
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-folio-file", file.id);
                onFileDragStart(file.id);
              }}
              onDragEnd={onFileDragEnd}
              aria-label={file.title}
              title={
                file.movable
                  ? `${file.title} - drag onto a folder to move`
                  : `${file.title} - fixed OKF path`
              }
              key={file.id}
            >
              <span className="tree-file-mark">M</span>
              <span>{explorerTitle(file.title)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
