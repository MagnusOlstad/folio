import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AskResult,
  MlxModelId,
  Note,
  SearchResult,
  SidebarMode,
  TreeDirectory,
  ViewerDocument,
} from "../../domain/types.ts";
import { MLX_GENERATION_MODEL } from "../../domain/types.ts";
import { readStorageItem, writeStorageItem } from "../../lib/storage.ts";
import type { Bundle } from "../../domain/types.ts";
import { WorkspaceExplorer } from "../workspace/components/WorkspaceExplorer.tsx";
import { PanelHeightHandle } from "../workspace/components/PanelHeightHandle.tsx";
import { usePanelHeightResize } from "../workspace/hooks/usePanelHeightResize.ts";
import type { ExplorerFileActions } from "../workspace/model/explorer.ts";

type OpenDocument = (
  id: string,
  source?: "note" | "file",
  targetGroupId?: string,
  disposition?: "preview" | "permanent",
) => Promise<void>;

export type WorkspaceSidebarProps = {
  sidebarMode: SidebarMode;
  setSidebarMode: Dispatch<SetStateAction<SidebarMode>>;
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
  activeFileId: string | null;
  activeFileDirectory: string | null;
  activeFileRevealRequest: number;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  openDocument: OpenDocument;
  setDraggedFileId: Dispatch<SetStateAction<string | null>>;
  setDropDirectoryPath: Dispatch<SetStateAction<string | null>>;
  moveBundleFile: (id: string, directory: string) => Promise<void>;
  notes: Note[];
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  selectedTag: string;
  searching: boolean;
  searchNotes: (query?: string, tag?: string) => Promise<void>;
  availableTags: string[];
  setSelectedTag: Dispatch<SetStateAction<string>>;
  setSearchResults: Dispatch<SetStateAction<SearchResult[]>>;
  searchTag: (tag: string) => void;
  searchResults: SearchResult[];
  selectedAnswerModel: MlxModelId;
  asking: boolean;
  question: string;
  setQuestion: Dispatch<SetStateAction<string>>;
  selectedAnswerModelMissing: boolean;
  askNotes: () => Promise<void>;
  answer: AskResult | null;
  conceptUrl: (id: string) => string;
  formatDate: (value: string) => string;
  bundles: Bundle[];
  activeBundleId: string | null;
  selectBundle: (id: string) => void;
  openSettings: () => void;
  actions: ExplorerFileActions;
  setMessage: (message: string) => void;
};

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const [recentCollapsed, setRecentCollapsed] = useState(
    () => readStorageItem("folio:recent-concepts-collapsed") === "true",
  );
  const { height: recentPanelHeight, minHeight: recentPanelMinHeight, maxHeight: recentPanelMaxHeight, panelRef: recentPanelRef, onPointerDown: onRecentPointerDown, onPointerMove: onRecentPointerMove, onPointerUp: onRecentPointerUp, onKeyDown: onRecentKeyDown } = usePanelHeightResize(recentCollapsed);
  const {
    sidebarMode, setSidebarMode, openDocument, notes, searchInputRef, searchQuery,
    setSearchQuery, selectedTag, searching, searchNotes, availableTags,
    setSelectedTag, setSearchResults, searchTag, searchResults,
    selectedAnswerModel, asking, question, setQuestion,
    selectedAnswerModelMissing, askNotes, answer, conceptUrl, formatDate,
  } = props;

  return (
    <aside className={`workbench-sidebar${recentCollapsed ? " recent-collapsed" : ""}`}>
      <nav className="sidebar-tabs" aria-label="Sidebar tools">
        {(["explore", "search", "ask"] as SidebarMode[]).map((mode) => (
          <button
            type="button"
            className={sidebarMode === mode ? "active" : ""}
            onClick={() => setSidebarMode(mode)}
            key={mode}
          >
            {mode}
          </button>
        ))}
      </nav>

      <section className="sidebar-panel">
        {sidebarMode === "explore" ? (
          <WorkspaceExplorer {...props} />
        ) : sidebarMode === "search" ? (
          <>
            <div className="sidebar-heading">
              <span>Search</span>
              <small>
                {notes.length} notes
              </small>
            </div>
            <form
              className="sidebar-form"
              onSubmit={(event) => {
                event.preventDefault();
                void searchNotes();
              }}
            >
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search by meaning"
                aria-label="Search your notes"
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void searchNotes();
                }}
              />
              <button
                type="submit"
                disabled={(!searchQuery.trim() && !selectedTag) || searching}
              >
                {searching ? "..." : "Go"}
              </button>
            </form>
            {availableTags.length > 0 && (
              <div className="sidebar-tags" aria-label="Filter by tag">
                <button
                  type="button"
                  className={!selectedTag ? "active" : ""}
                  onClick={() => {
                    setSelectedTag("");
                    if (searchQuery.trim()) void searchNotes(searchQuery, "");
                    else setSearchResults([]);
                  }}
                >
                  All
                </button>
                {availableTags.map((tag) => (
                  <button
                    type="button"
                    className={selectedTag === tag ? "active" : ""}
                    onClick={() => searchTag(tag)}
                    key={tag}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}
            <div className="sidebar-results">
              {searchResults.map((result) => (
                <button
                  type="button"
                  className="sidebar-result"
                  onClick={() =>
                    void openDocument(result.id, "note", undefined, "preview")
                  }
                  onDoubleClick={() =>
                    void openDocument(result.id, "note", undefined, "permanent")
                  }
                  key={result.id}
                >
                  <span>
                    {result.type} / {Math.round(result.score * 100)}%
                  </span>
                  <strong>
                    <span>{result.title}</span>
                    {result.updatedAt && !Number.isNaN(Date.parse(result.updatedAt)) && (
                      <time dateTime={result.updatedAt}>{formatDate(result.updatedAt)}</time>
                    )}
                  </strong>
                  <p>{result.snippet}</p>
                </button>
              ))}
              {!searchResults.length && (
                <p className="sidebar-empty">
                  Search results open as editor tabs.
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="sidebar-heading">
              <span>Ask</span>
              <select defaultValue={selectedAnswerModel} disabled aria-label="Answer model">
                <option value={MLX_GENERATION_MODEL.id}>{MLX_GENERATION_MODEL.name}</option>
              </select>
            </div>
            <form
              className="sidebar-ask-form"
              onSubmit={(event) => {
                event.preventDefault();
                void askNotes();
              }}
            >
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Ask your notes..."
                aria-label="Question for your notes"
              />
              <button
                type="submit"
                disabled={
                  !question.trim() || asking || selectedAnswerModelMissing
                }
              >
                {asking ? "Thinking..." : "Ask notes"}
              </button>
            </form>
            <div className="sidebar-answer">
              {answer ? (
                <>
                  <div className="answer-copy">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) =>
                          href?.startsWith("/") ? (
                            <a
                              href={conceptUrl(href)}
                              onClick={(event) => {
                                event.preventDefault();
                                void openDocument(href, "note", undefined, "preview");
                              }}
                              onDoubleClick={(event) => {
                                event.preventDefault();
                                void openDocument(href, "note", undefined, "permanent");
                              }}
                            >
                              {children}
                            </a>
                          ) : (
                            <span className="citation">{children}</span>
                          ),
                      }}
                    >
                      {answer.answer}
                    </ReactMarkdown>
                  </div>
                  <div className="answer-sources">
                    {answer.sources.map(
                      (source: { id: string; title: string }) => (
                        <button
                          type="button"
                          onClick={() => void openDocument(source.id, "note", undefined, "preview")}
                          onDoubleClick={() => void openDocument(source.id, "note", undefined, "permanent")}
                          key={source.id}
                        >
                          {source.title}
                        </button>
                      ),
                    )}
                  </div>
                </>
              ) : (
                <p className="sidebar-empty">
                  Answers stay here. Sources open in the editor.
                </p>
              )}
            </div>
          </>
        )}
      </section>

      <section className={`recent-panel${recentPanelHeight !== null ? " is-resized" : ""}`} ref={recentPanelRef} style={{ height: recentPanelHeight ?? undefined }} aria-label="Recent concepts">
        <PanelHeightHandle
          label="Resize Recent concepts panel"
          value={recentPanelHeight}
          minHeight={recentPanelMinHeight}
          maxHeight={recentPanelMaxHeight}
          onPointerDown={onRecentPointerDown}
          onPointerMove={onRecentPointerMove}
          onPointerUp={onRecentPointerUp}
          onKeyDown={onRecentKeyDown}
        />
        <button
          type="button"
          className="recent-heading"
          aria-label={recentCollapsed ? "Expand Recent concepts" : "Collapse Recent concepts"}
          aria-expanded={!recentCollapsed}
          aria-controls="recent-concepts-list"
          onClick={() => {
            const nextCollapsed = !recentCollapsed;
            setRecentCollapsed(nextCollapsed);
            writeStorageItem("folio:recent-concepts-collapsed", String(nextCollapsed));
          }}
        >
          <span className="model-status-summary" role="heading" aria-level={2}>Recent concepts</span>
          <span className="recent-heading-controls">
            <small>{notes.length}</small>
            <svg aria-hidden="true" viewBox="0 0 16 16"><path d={recentCollapsed ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} /></svg>
          </span>
        </button>
        <div className="recent-list" id="recent-concepts-list" hidden={recentCollapsed}>
          {notes.slice(0, 7).map((note) => (
            <button
              type="button"
              className="recent-row"
              key={note.id}
              onClick={() => void openDocument(note.id, "note", undefined, "preview")}
              onDoubleClick={() => void openDocument(note.id, "note", undefined, "permanent")}
            >
              <span
                className={`type-pip type-${note.type.toLowerCase().replace(/\s+/g, "-")}`}
              />
              <span>
                <strong>{note.title}</strong>
                <small>
                  {note.type} / {formatDate(note.createdAt)}
                </small>
              </span>
            </button>
          ))}
          {!notes.length && <p className="sidebar-empty">No concepts yet.</p>}
        </div>
      </section>
    </aside>
  );
}
