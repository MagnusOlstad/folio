import { useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  SidebarMode,
  TabGroup,
  ViewerDocument,
} from "../../../domain/types.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import {
  useWorkspaceCommands,
  type WorkspaceShortcutAction,
} from "./useWorkspaceCommands.ts";

declare global {
  interface Window {
    folio?: {
      onMenuAction?: (handler: (action: string) => void) => () => void;
      closeWindow?: () => void;
    };
  }
}

type Options = {
  sidebarMode: SidebarMode;
  setSidebarMode: Dispatch<SetStateAction<SidebarMode>>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  groups: TabGroup[];
  activeGroupId: string;
  documents: Record<string, ViewerDocument>;
  createNewTab: () => void;
  closeTab: (groupId: string, documentId: string) => void;
  fileDraft: (document: ViewerDocument) => void;
  flushDocument: (documentId: string) => Promise<void>;
};

export function useWorkspaceShortcutActions(options: Options) {
  const runShortcutRef = useRef<
    ((action: WorkspaceShortcutAction) => void) | null
  >(null);

  function saveActiveDocument() {
    const group = options.groups.find(
      (candidate) => candidate.id === options.activeGroupId,
    );
    const documentId = group?.activeId;
    if (!documentId) return;
    const activeDocument = options.documents[documentId];
    if (!activeDocument) return;
    if (isUntitledId(documentId)) {
      options.fileDraft(activeDocument);
      return;
    }
    void options.flushDocument(documentId);
  }

  function runShortcut(action: WorkspaceShortcutAction) {
    if (action === "new-note") return options.createNewTab();
    if (action === "close-tab") {
      const group = options.groups.find(
        (candidate) => candidate.id === options.activeGroupId,
      );
      if (group?.activeId) options.closeTab(group.id, group.activeId);
      else window.folio?.closeWindow?.();
      return;
    }
    if (action === "save") return saveActiveDocument();
    if (action === "search") return focusSearchInput();
    const target = document.activeElement;
    if (
      target instanceof HTMLElement &&
      target.closest(".document-editor, .live-markdown-editor")
    ) {
      target.dispatchEvent(
        new CustomEvent("folio-format", { detail: action, cancelable: true }),
      );
    }
  }

  const { focusSearchInput } = useWorkspaceCommands({
    sidebarMode: options.sidebarMode,
    setSidebarMode: options.setSidebarMode,
    searchInputRef: options.searchInputRef,
    runShortcutRef,
    runShortcut,
  });
}
