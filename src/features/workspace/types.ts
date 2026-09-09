import type { PointerEvent } from "react";
import type {
  TabGroup,
  ViewerDocument,
} from "../../domain/types.ts";
import type { FilingFields, FilingQueueEntry } from "./model/filing.ts";

export type TabDrag = { documentId: string; groupId: string };
export type MetadataField = "title" | "description";

export type EditorWorkspaceModel = {
  groups: TabGroup[];
  splitPosition: number;
  activeGroupId: string;
  documents: Record<string, ViewerDocument>;
  loadingDocuments: Set<string>;
  savingDocuments: Set<string>;
  editingKey: string | null;
  drafts: Record<string, string>;
  deletingNoteId: string | null;
  movingFileId: string | null;
  filingDirectories: string[];
  filingQueues: Record<string, FilingQueueEntry[]>;
  message: string;
};

export type EditorWorkspaceActions = {
  beginHorizontalResize: (event: PointerEvent<HTMLElement>) => void;
  resizeSplit: (clientX: number, handle: HTMLElement) => void;
  finishHorizontalResize: (event: PointerEvent<HTMLElement>) => void;
  resetSplit: () => void;
  activateGroup: (groupId: string) => void;
  moveTabToGroup: (
    documentId: string,
    sourceGroupId: string,
    targetGroupId: string,
  ) => void;
  titleForId: (id: string) => string;
  activateTab: (groupId: string, documentId: string) => void;
  createNewTab: (targetGroupId?: string) => void;
  splitWorkspace: () => void;
  closeGroup: (groupId: string) => void;
  closeTab: (groupId: string, documentId: string) => void;
  changeDraftContent: (document: ViewerDocument, content: string) => void;
  fileDraft: (document: ViewerDocument) => void;
  changeFilingFields: (documentId: string, fields: FilingFields) => void;
  revealStandaloneFiling: (documentId: string) => void;
  confirmFiling: (groupId: string, documentId: string, action: "accept" | "standalone") => void;
  dismissFiling: (groupId: string, documentId: string) => void;
  beginEditing: (
    groupId: string,
    document: ViewerDocument,
  ) => void;
  finishEditing: (
    groupId: string,
    document: ViewerDocument,
    scrollTop?: number,
  ) => void;
  openDocument: (
    id: string,
    source?: "note" | "file",
    targetGroupId?: string,
  ) => Promise<void>;
  toggleTaskCheckbox: (
    document: ViewerDocument,
    lineNumber: number,
    checked: boolean,
  ) => Promise<void>;
  deleteFiledNote: (document: ViewerDocument) => Promise<void>;
  persistDocument: (
    document: ViewerDocument,
    nextContent: string,
    nextTags: string[],
  ) => void;
  persistMetadata: (
    document: ViewerDocument,
    field: MetadataField,
    value: string,
  ) => void;
  moveBundleFile: (id: string, directory: string) => Promise<void>;
  dismissMessage: () => void;
};

export type EditorWorkspaceProps = {
  model: EditorWorkspaceModel;
  actions: EditorWorkspaceActions;
};
