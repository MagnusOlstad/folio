export type Note = {
  id: string;
  rawId: string | null;
  title: string;
  type: string;
  description: string;
  tags: string[];
  relatedIds: string[];
  createdAt: string;
  updatedAt?: string;
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
export type NoteHistoryEntry = {
  revision: string;
  authoredAt: string;
  title: string;
};
export type NoteHistoryPage = {
  entries: NoteHistoryEntry[];
  nextCursor: string | null;
};
export type NoteHistorySnapshot = {
  revision: string;
  note: Pick<NoteDetail, "title" | "description" | "tags" | "status" | "staleAfter" | "content">;
  diff: string;
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
export type RefileResult = {
  oldId: string;
  newId: string;
  warning: string | null;
  note: NoteDetail & { deletable: boolean };
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
export type BundleDirectory = { path: string };
export type Bundle = {
  id: string;
  name: string;
  markdownPath: string;
  managed: boolean;
  detached: boolean;
};
export type BundleRegistryResponse = {
  version: 1;
  bundles: Bundle[];
  error: string | null;
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
  checkError?: string | null;
  updateAvailable: boolean;
};
export type DesktopUpdateState = {
  status: "checking" | "idle" | "available" | "downloading" | "downloaded" | "staging" | "installing" | "error";
  version: string | null;
  percent: number | null;
  error: string | null;
};
export type MlxModelId = "gemma4" | "qwen35" | "llama32" | "embeddinggemma" | "whisper" | "whisperlarge";
export type MlxTranscriptionModelId = "whisper" | "whisperlarge";
export const MLX_GENERATION_MODEL = { id: "gemma4", name: "Gemma 4 E4B" } as const satisfies {
  id: MlxModelId;
  name: string;
};
export type MlxModelStatus = {
  id: MlxModelId;
  name: string;
  purpose: "generation" | "embeddings" | "transcription";
  downloadSizeBytes: number;
  downloadSizeIsEstimate: boolean;
  selected: boolean;
  installed: boolean;
  loaded: boolean;
  loading?: boolean;
  busy?: boolean;
  requestCount?: number;
  memory: { activeBytes: number; cacheBytes: number; peakResidentBytes: number } | null;
};
export type MlxDownloadProgress = {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  phase: "downloading" | "loading";
};
export type MlxStatus = {
  available: boolean;
  helperAvailable: boolean;
  keepAliveMs: number;
  activeModel?: MlxModelId | null;
  installing: MlxModelId[];
  selectedGenerationModel: MlxModelId;
  selectedTranscriptionModel?: MlxTranscriptionModelId;
  downloads: { id: MlxModelId; progress: MlxDownloadProgress | null }[];
  models: MlxModelStatus[];
};
export type AskResult = {
  answer: string;
  sources: Note[];
  model: string;
  retrieval: string;
};
export type SidebarMode = "explore" | "search" | "ask";
export type TabGroup = {
  id: string;
  tabs: string[];
  activeId: string | null;
  previewId: string | null;
};
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
