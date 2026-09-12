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
  | "new-transcription"
  | "close-tab"
  | "save"
  | "search"
  | "find-in-note"
  | "export-markdown"
  | "export-pdf"
  | "open-settings"
  | `switch-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | FormatMarker;

const KEYBOARD_SHORTCUTS: Record<string, WorkspaceShortcutAction> = {
  t: "new-note",
  w: "close-tab",
  s: "save",
  b: "bold",
  i: "italic",
  k: "link",
};

const TAB_SHORTCUTS: Record<
  string,
  Extract<WorkspaceShortcutAction, `switch-tab-${number}`>
> = {
  1: "switch-tab-1",
  2: "switch-tab-2",
  3: "switch-tab-3",
  4: "switch-tab-4",
  5: "switch-tab-5",
  6: "switch-tab-6",
  7: "switch-tab-7",
  8: "switch-tab-8",
  9: "switch-tab-9",
};

const MENU_ACTIONS = new Set<string>([
  ...Object.values(KEYBOARD_SHORTCUTS),
  "new-transcription",
  "search",
  "find-in-note",
  "export-markdown",
  "export-pdf",
  "open-settings",
  ...Object.values(TAB_SHORTCUTS),
]);

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
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        runShortcutRef.current?.(event.shiftKey ? "search" : "find-in-note");
        return;
      }
      if (event.shiftKey) return;
      const tabAction = TAB_SHORTCUTS[event.key];
      if (tabAction) {
        event.preventDefault();
        runShortcutRef.current?.(tabAction);
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
    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribeMenuActions = window.folio?.onMenuAction?.((action) => {
      if (MENU_ACTIONS.has(action))
        runShortcutRef.current?.(action as WorkspaceShortcutAction);
      else
        console.warn(
          `Ignored unknown menu action from main process: "${action}"`,
        );
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
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
