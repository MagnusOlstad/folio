import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { ExplorerContextMenuState, ExplorerFileActions } from "../model/explorer.ts";
import {
  explorerTargetName,
  explorerTargetParent,
  explorerTargetPath,
  canDeleteExplorerDirectory,
} from "../model/explorer.ts";

type ExplorerContextMenuProps = {
  state: ExplorerContextMenuState;
  bundlePath: string;
  actions: ExplorerFileActions;
  blockedFileIds: Set<string>;
  onDismiss: (restoreFocus?: boolean) => void;
  onError: (message: string) => void;
};

type FormMode = "rename" | "create-folder" | "delete" | null;

export function ExplorerContextMenu({
  state,
  bundlePath,
  actions,
  blockedFileIds,
  onDismiss,
  onError,
}: ExplorerContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const target = state.target;
  const canRename = target.kind === "directory"
    ? false
    : target.file.movable && !blockedFileIds.has(target.file.id);
  const canDelete = target.kind === "file"
    && target.file.deletable
    && target.file.movable
    && !blockedFileIds.has(target.file.id);
  const canDeleteDirectory = target.kind === "directory" && canDeleteExplorerDirectory(target.path);
  const canDeleteTarget = canDelete || canDeleteDirectory;
  const targetPath = explorerTargetPath(target);
  const absolutePath = `${bundlePath.replace(/[\\/]$/, "")}${targetPath}`;
  const relativePath = targetPath === "/" ? "." : targetPath.slice(1);

  useEffect(() => {
    if (formMode) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    }
  }, [formMode]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onDismiss(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss(true);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

  async function run(action: () => Promise<void>) {
    setWorking(true);
    try {
      await action();
      onDismiss();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Explorer action failed.");
    } finally {
      setWorking(false);
    }
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || working) return;
    const nextName = name.trim();
    if (formMode === "rename") {
      if (target.kind === "file") await run(() => actions.renameFile(target.file.id, nextName));
    } else if (formMode === "create-folder") {
      await run(() => actions.createDirectory(explorerTargetParent(target), nextName));
    }
  }

  function openForm(mode: Exclude<FormMode, null>) {
    setName(mode === "rename" ? explorerTargetName(target) : "");
    setFormMode(mode);
  }

  function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"),
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    event.preventDefault();
    items[(index + direction + items.length) % items.length]?.focus();
  }

  const x = Math.max(4, Math.min(state.x, window.innerWidth - 244));
  const y = Math.max(4, Math.min(state.y, window.innerHeight - 360));

  return (
    <div
      className="explorer-context-menu"
      ref={menuRef}
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {formMode ? (
        <form className="explorer-context-dialog" role="dialog" aria-label={formMode === "delete" ? "Confirm delete" : formMode.replaceAll("-", " ")} onSubmit={submitForm}>
          {formMode === "delete" ? (
            <>
              <strong>Delete {explorerTargetName(target)}?</strong>
              <p>{target.kind === "file" ? "This permanently deletes the Markdown file from this bundle." : "Only an empty folder can be deleted from this bundle."}</p>
              <div className="explorer-context-actions">
                <button type="button" onClick={() => onDismiss(true)} disabled={working}>Cancel</button>
                <button
                  type="button"
                  className="danger"
                  disabled={working || !canDeleteTarget}
                  onClick={() => {
                    if (target.kind === "file") void run(() => actions.deleteFile(target.file));
                    else if (canDeleteDirectory) void run(() => actions.deleteDirectory(target.path));
                  }}
                >
                  {working ? "Deleting…" : "Delete"}
                </button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor="explorer-context-name">
                {formMode === "rename" ? "Rename" : "New folder"}
              </label>
              <input
                id="explorer-context-name"
                ref={inputRef}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                disabled={working}
                maxLength={100}
                required
              />
              <div className="explorer-context-actions">
                <button type="button" onClick={() => setFormMode(null)} disabled={working}>Cancel</button>
                <button type="submit" disabled={working || !name.trim()}>{working ? "Saving…" : "Save"}</button>
              </div>
            </>
          )}
        </form>
      ) : (
        <div role="menu" aria-label={`${explorerTargetName(target)} actions`} onKeyDown={moveMenuFocus}>
          <button role="menuitem" type="button" onClick={() => void run(() => actions.createFile(explorerTargetParent(target)))}>New note</button>
          <button role="menuitem" type="button" onClick={() => openForm("create-folder")}>New folder</button>
          {target.kind === "file" ? (
            <button role="menuitem" type="button" disabled={!canRename} onClick={() => openForm("rename")}>Rename file</button>
          ) : null}
          <button role="menuitem" type="button" onClick={() => void run(() => actions.copyText(absolutePath))}>Copy absolute path</button>
          <button role="menuitem" type="button" onClick={() => void run(() => actions.copyText(relativePath))}>Copy relative path</button>
          {target.kind === "file" ? (
            <>
              <button role="menuitem" type="button" onClick={() => void run(() => actions.exportFile(target.file, "markdown"))}>Export Markdown</button>
              <button role="menuitem" type="button" onClick={() => void run(() => actions.exportFile(target.file, "pdf"))}>Export PDF</button>
              <button role="menuitem" type="button" className="danger" disabled={!canDelete} onClick={() => setFormMode("delete")}>Delete</button>
            </>
          ) : canDeleteDirectory ? <button role="menuitem" type="button" className="danger" onClick={() => setFormMode("delete")}>Delete</button> : null}
        </div>
      )}
    </div>
  );
}
