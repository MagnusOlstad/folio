import { useEffect, useLayoutEffect } from "react";
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import type { FormatMarker } from "../../../markdown-format.ts";
import type { SidebarMode } from "../../../domain/types.ts";

export type WorkspaceShortcutAction =
  | "new-note"
  | "close-tab"
  | "save"
  | "search"
  | FormatMarker;

const KEYBOARD_SHORTCUTS: Record<string, WorkspaceShortcutAction> = {
  t: "new-note",
  w: "close-tab",
  s: "save",
  b: "bold",
  i: "italic",
  k: "link",
};

const MENU_ACTIONS = new Set<string>(Object.values(KEYBOARD_SHORTCUTS));

type UseWorkspaceCommandsOptions = {
  sidebarMode: SidebarMode;
  setSidebarMode: Dispatch<SetStateAction<SidebarMode>>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  runShortcutRef: MutableRefObject<
    ((action: WorkspaceShortcutAction) => void) | null
  >;
  runShortcut: (action: WorkspaceShortcutAction) => void;
};

export function useWorkspaceCommands({
  sidebarMode,
  setSidebarMode,
  searchInputRef,
  runShortcutRef,
  runShortcut,
}: UseWorkspaceCommandsOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      // Matches Obsidian: plain Cmd/Ctrl+F is left for the browser/OS's own find-in-page.
      if (event.shiftKey) {
        if (event.key.toLowerCase() !== "f") return;
        event.preventDefault();
        runShortcutRef.current?.("search");
        return;
      }
      const action = KEYBOARD_SHORTCUTS[event.key.toLowerCase()];
      if (!action) return;
      // Browsers can't have Cmd/Ctrl+W's tab-close prevented, so don't also run our
      // own close-tab logic there; the desktop app still gets it via the menu accelerator.
      if (action === "close-tab" && !window.folio) return;
      if (action === "bold" || action === "italic" || action === "link") {
        const target = document.activeElement;
        if (
          !(target instanceof HTMLElement) ||
          !target.closest(".document-editor, .live-markdown-editor")
        )
          return;
        event.preventDefault();
        target.dispatchEvent(
          new CustomEvent("folio-format", { detail: action, cancelable: true }),
        );
        return;
      }
      event.preventDefault();
      runShortcutRef.current?.(action);
    };
    window.addEventListener("keydown", onKeyDown);
    const unsubscribeMenuActions = window.folio?.onMenuAction?.((action) => {
      if (MENU_ACTIONS.has(action))
        runShortcutRef.current?.(action as WorkspaceShortcutAction);
      else
        console.warn(
          `Ignored unknown menu action from main process: "${action}"`,
        );
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeMenuActions?.();
    };
  }, [runShortcutRef]);

  useLayoutEffect(() => {
    runShortcutRef.current = runShortcut;
  });

  function focusSearchInput() {
    if (sidebarMode !== "search") {
      setSidebarMode("search");
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
      return;
    }
    searchInputRef.current?.focus();
  }

  return { focusSearchInput };
}
