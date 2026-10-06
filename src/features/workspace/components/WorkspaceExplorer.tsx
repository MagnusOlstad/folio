import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Bundle, TreeDirectory, ViewerDocument } from "../../../domain/types.ts";
import type { ExplorerContextMenuState, ExplorerContextTarget, ExplorerFileActions } from "../model/explorer.ts";
import { ExplorerContextMenu } from "./ExplorerContextMenu.tsx";
import { FileTree } from "./FileTree.tsx";

export type WorkspaceExplorerProps = {
  explorerScrollTop: number;
  onExplorerScroll: (scrollTop: number) => void;
  filesLoading: boolean;
  localDraftDocuments: ViewerDocument[];
  drafts: Record<string, string>;
  draftTitle: (value: string) => string;
  openLocalDraft: (id: string) => void;
  deleteLocalDraft: (id: string) => Promise<void>;
  deletingDraftIds: Set<string>;
  savingDocuments: Set<string>;
  fileTree: TreeDirectory;
  expandedDirectories: Set<string>;
  draggedFileId: string | null;
  dropDirectoryPath: string | null;
  movingFileId: string | null;
  blockedFileIds: Set<string>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  openDocument: (id: string, source?: "note" | "file", targetGroupId?: string, disposition?: "preview" | "permanent") => Promise<void>;
  setDraggedFileId: Dispatch<SetStateAction<string | null>>;
  setDropDirectoryPath: Dispatch<SetStateAction<string | null>>;
  moveBundleFile: (id: string, directory: string) => Promise<void>;
  bundles: Bundle[];
  activeBundleId: string | null;
  selectBundle: (id: string) => void;
  openSettings: () => void;
  actions: ExplorerFileActions;
  setMessage: (message: string) => void;
};

export function WorkspaceExplorer(props: WorkspaceExplorerProps) {
  const [collapsedBundleId, setCollapsedBundleId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ExplorerContextMenuState | null>(null);
  const {
    explorerScrollTop,
    onExplorerScroll,
    filesLoading,
    localDraftDocuments,
    drafts,
    draftTitle,
    openLocalDraft,
    deleteLocalDraft,
    deletingDraftIds,
    savingDocuments,
    fileTree,
    expandedDirectories,
    draggedFileId,
    dropDirectoryPath,
    movingFileId,
    blockedFileIds,
    setExpandedDirectories,
    openDocument,
    setDraggedFileId,
    setDropDirectoryPath,
    moveBundleFile,
    bundles,
    activeBundleId,
    selectBundle,
    openSettings,
    actions,
    setMessage,
  } = props;
  const activeBundle = bundles.find((bundle) => bundle.id === activeBundleId);

  const closeContextMenu = useCallback((restoreFocus = true) => {
    const anchor = contextMenu?.anchor;
    setContextMenu(null);
    if (restoreFocus && anchor?.isConnected) window.requestAnimationFrame(() => anchor.focus());
  }, [contextMenu]);

  function showContextMenu(
    target: ExplorerContextTarget,
    x: number,
    y: number,
    anchor: HTMLElement,
  ) {
    setContextMenu({ target, x, y, anchor });
  }

  function handleBundleClick(bundleId: string) {
    if (bundleId === activeBundleId) {
      setCollapsedBundleId((current) => current === bundleId ? null : bundleId);
      return;
    }
    setCollapsedBundleId(null);
    selectBundle(bundleId);
  }

  function openRootContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest(".tree-row")) return;
    event.preventDefault();
    if (activeBundle) showContextMenu({ kind: "directory", path: "/" }, event.clientX, event.clientY, event.currentTarget);
  }

  return (
    <>
      {bundles.length > 0 ? (
        <div className="bundle-explorer-list" aria-label="Bundles">
          {bundles.map((bundle) => {
            const active = bundle.id === activeBundleId;
            const expanded = active && bundle.id !== collapsedBundleId;
            return (
              <div
                className={`bundle-explorer-root${active ? " active" : ""}${expanded ? " expanded" : ""}`}
                key={bundle.id}
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={active ? `bundle-tree-${bundle.id}` : undefined}
                  className={`bundle-explorer-heading${active ? " active" : ""}${expanded ? " expanded" : ""}`}
                  onClick={() => handleBundleClick(bundle.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!active) return;
                    showContextMenu({ kind: "directory", path: "/" }, event.clientX, event.clientY, event.currentTarget);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                    event.preventDefault();
                    if (!active) return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    showContextMenu({ kind: "directory", path: "/" }, bounds.left, bounds.bottom, event.currentTarget);
                  }}
                  title={bundle.markdownPath}
                >
                  <span className="bundle-explorer-chevron" aria-hidden="true">›</span>
                  <span className="bundle-explorer-icon" aria-hidden="true">▱</span>
                  <span className="bundle-explorer-name">{bundle.name}</span>
                  {active ? <span className="bundle-explorer-active" aria-label="Active bundle" /> : null}
                </button>
                {active && expanded ? (
                  <div
                    className="bundle-explorer-content"
                    id={`bundle-tree-${bundle.id}`}
                    onContextMenu={openRootContextMenu}
                  >
                    <div
                      className="tree-scroll"
                      style={{ overflowAnchor: "none" }}
                      onScroll={(event) => onExplorerScroll(event.currentTarget.scrollTop)}
                      ref={(element) => {
                        if (element && element.scrollTop !== explorerScrollTop)
                          element.scrollTop = explorerScrollTop;
                      }}
                    >
                      {filesLoading ? (
                        <p className="sidebar-empty">Reading bundle...</p>
                      ) : (
                        <>
                          {localDraftDocuments.length ? (
                            <div className="tree-branch local-drafts">
                              <div className="tree-row tree-directory static" style={{ "--tree-depth": 0 } as React.CSSProperties}>
                                <span className="tree-chevron">v</span>
                                <span className="tree-folder" aria-hidden="true" />
                                <span>Drafts</span>
                                <small>{localDraftDocuments.length}</small>
                              </div>
                              {localDraftDocuments.map((draft) => (
                                <div className="tree-row tree-file draft-tree-row" style={{ "--tree-depth": 1 } as React.CSSProperties} key={draft.id}>
                                  <button type="button" className="draft-tree-open" onClick={() => openLocalDraft(draft.id)} title="Local draft">
                                    <span className="tree-file-mark">D</span>
                                    <span>{draftTitle(drafts[draft.id] ?? draft.content)}</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="draft-tree-delete"
                                    onClick={() => void deleteLocalDraft(draft.id)}
                                    disabled={deletingDraftIds.has(draft.id) || savingDocuments.has(draft.id)}
                                    title="Delete draft"
                                    aria-label={`Delete ${draftTitle(drafts[draft.id] ?? draft.content)}`}
                                  >
                                    x
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          <FileTree
                            directory={fileTree}
                            depth={0}
                            hideRoot
                            expanded={expandedDirectories}
                            draggedFileId={draggedFileId}
                            dropDirectoryPath={dropDirectoryPath}
                            movingFileId={movingFileId}
                            blockedFileIds={blockedFileIds}
                            onToggle={(path) => setExpandedDirectories((current) => {
                              const next = new Set(current);
                              if (next.has(path)) next.delete(path);
                              else next.add(path);
                              return next;
                            })}
                            onOpen={(id, disposition) => void openDocument(id, "file", undefined, disposition)}
                            onFileDragStart={setDraggedFileId}
                            onFileDragEnd={() => {
                              setDraggedFileId(null);
                              setDropDirectoryPath(null);
                            }}
                            onDirectoryDragOver={setDropDirectoryPath}
                            onMove={(id, directory) => void moveBundleFile(id, directory)}
                            onContextMenu={showContextMenu}
                          />
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bundle-explorer-empty">
          <span aria-hidden="true">▱</span>
          <strong>A space for your notes</strong>
          <p>Create a bundle or open an existing Folio bundle to get started.</p>
          <button type="button" className="bundle-setup-cta" onClick={openSettings}>Add or import bundle</button>
        </div>
      )}
      {contextMenu && activeBundle ? (
        <ExplorerContextMenu
          state={contextMenu}
          bundlePath={activeBundle.markdownPath}
          actions={actions}
          blockedFileIds={blockedFileIds}
          onDismiss={closeContextMenu}
          onError={setMessage}
        />
      ) : null}
    </>
  );
}
