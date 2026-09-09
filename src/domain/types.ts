export type Note = {
  id: string;
  rawId: string | null;
  title: string;
  type: string;
  description: string;
  tags: string[];
  relatedIds: string[];
  createdAt: string;
  classifiedByModel: boolean;
  status: "draft" | "stable" | "deprecated";
  staleAfter: string | null;
  stale: boolean;
  filedBy: string | null;
  filedAt: string | null;
};

export type Relationship = {
  id: string;
  title: string;
  type: string;
  description: string;
  createdAt: string;
  relation: string;
  origin: "frontmatter" | "content" | "semantic";
};

export type SearchResult = Note & { snippet: string; score: number };
export type NoteDetail = Note & {
  content: string;
  movable: boolean;
  links: Relationship[];
  backlinks: Relationship[];
  suggestions: Relationship[];
};
export type NoteUpdateResult = NoteDetail & {
  oldId: string;
  newId: string;
  warning: string | null;
};
export type FilingMode = "new" | "existing" | "todo" | "daily";
export type FilingProposal = {
  directory: string;
  filename: string;
  title: string;
  description: string;
  tags: string[];
};
export type Filing = {
  id: string;
  draftId: string;
  mode: FilingMode;
  destinationId: string | null;
  actor: string;
  proposal: FilingProposal;
  standaloneProposal?: FilingProposal;
};
export type FilingConfirmResult = {
  note: Note;
  notes: Note[];
  warning: string | null;
  oldId: string;
  newId: string;
  appended: boolean;
  sourceRemoved?: boolean;
};
export type ViewerDocument = {
  id: string;
  title: string;
  type: string;
  description: string;
  tags: string[];
  createdAt: string;
  content: string;
  deletable: boolean;
  movable: boolean;
  status: "draft" | "stable" | "deprecated";
  staleAfter: string | null;
  stale: boolean;
  filedBy: string | null;
  filedAt: string | null;
  links: Relationship[];
  backlinks: Relationship[];
  suggestions: Relationship[];
  updatedAt?: string;
};
export type FileMoveResult = {
  oldId: string;
  newId: string;
  warning: string | null;
  note: ViewerDocument;
};
export type BundleFile = {
  id: string;
  name: string;
  title: string;
  createdAt: string;
  directory: string;
  type: string;
  deletable: boolean;
  movable: boolean;
  filedBy: string | null;
  filedAt: string | null;
};
export type StoredDraft = {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};
export type VersionInfo = {
  version: string;
  repo: string;
  latest: string | null;
  latestUrl?: string;
  updateAvailable: boolean;
};
export type ModelStatus = {
  online: boolean;
  canLaunch: boolean;
  classifierModel: string;
  answerModel: string;
  answerModels: string[];
  embedModel: string;
  configuredModels: string[];
  missingModels: string[];
  installingModels: string[];
  installed: string[];
  running: string[];
  embeddingCoverage: {
    conceptsEmbedded: number;
    conceptsTotal: number;
    chunksEmbedded: number;
    chunksTotal: number;
    refreshing: boolean;
  };
};
export type AskResult = {
  answer: string;
  sources: Note[];
  model: string;
  retrieval: string;
};
export type SidebarMode = "explore" | "search" | "ask";
export type TabGroup = { id: string; tabs: string[]; activeId: string | null };
export type TreeDirectory = {
  name: string;
  path: string;
  directories: TreeDirectory[];
  files: BundleFile[];
};
export type EditorIntent = { lineNumber: number; scrollTop: number };
export type ExpandedDirectoryState = {
  directories: Set<string>;
  restored: boolean;
};
export type MarkdownNode = {
  position?: { start: { line: number }; end: { line: number } };
};
