import type { PointerEvent } from "react";
import type {
  NoteHistorySnapshot,
  TabGroup,
  ViewerDocument,
} from "../../domain/types.ts";
import type { FilingFields, FilingQueueEntry } from "./model/filing.ts";
import type { NoteExportFormat } from "./model/note-export.ts";
import type { RefileEntries, RefileFields } from "./model/refile.ts";

export type TabDrag = { documentId: string; groupId: string };
export type MetadataField = "title" | "description";
export type EditorFocusRequest = {
  id: number;
  groupId: string;
  documentId: string;
};

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
  refileEntries: RefileEntries;
  editorFocusRequest: EditorFocusRequest | null;
  message: string;
  exportingNoteId: string | null;
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
    targetIndex?: number,
  ) => void;
  titleForId: (id: string) => string;
  activateTab: (groupId: string, documentId: string) => void;
  pinTab: (groupId: string, documentId: string) => void;
  consumeEditorFocusRequest: (requestId: number) => void;
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
  startRefile: (documentId: string) => void;
  changeRefileFields: (documentId: string, fields: RefileFields) => void;
  acceptRefile: (documentId: string) => void;
  dismissRefile: (documentId: string) => void;
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
  exportDocument: (
    document: ViewerDocument,
    format: NoteExportFormat,
  ) => void;
  beforeHistoryRestore: (documentId: string) => Promise<void>;
  historyRestored: (documentId: string) => Promise<void>;
  notifyMessage: (message: string) => void;
  dismissMessage: () => void;
  getDocumentScrollTop: (documentId: string) => number;
  rememberDocumentScrollTop: (documentId: string, scrollTop: number) => void;
  getDocumentSelection: (documentId: string) => { from: number; to: number } | undefined;
  rememberDocumentSelection: (documentId: string, from: number, to: number) => void;
};

export type EditorWorkspaceProps = {
  model: EditorWorkspaceModel;
  actions: EditorWorkspaceActions;
  historyPreview?: {
    groupId: string;
    documentId: string;
    snapshot: NoteHistorySnapshot | null;
    loading: boolean;
    failed: boolean;
    presentContent: string;
  };
  paneControls?: {
    leftOpen: boolean;
    rightOpen: boolean;
    updateAvailable: boolean;
    onToggleLeft: () => void;
    onToggleRight: () => void;
  };
};
