import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { FileTree } from "../explorer/FileTree.tsx";
import type {
  AskResult,
  ModelStatus,
  Note,
  SearchResult,
  SidebarMode,
  TreeDirectory,
  ViewerDocument,
} from "../../domain/types.ts";

type OpenDocument = (
  id: string,
  source?: "note" | "file",
  targetGroupId?: string,
  disposition?: "preview" | "permanent",
) => Promise<void>;

export type WorkspaceSidebarProps = {
  sidebarMode: SidebarMode;
  setSidebarMode: Dispatch<SetStateAction<SidebarMode>>;
  reindexing: boolean;
  reindexBundle: () => Promise<void>;
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
  openDocument: OpenDocument;
  setDraggedFileId: Dispatch<SetStateAction<string | null>>;
  setDropDirectoryPath: Dispatch<SetStateAction<string | null>>;
  moveBundleFile: (id: string, directory: string) => Promise<void>;
  status: ModelStatus | null;
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
  selectedAnswerModel: string;
  setAskModel: Dispatch<SetStateAction<string>>;
  setAnswer: Dispatch<SetStateAction<AskResult | null>>;
  asking: boolean;
  configuredAnswerModels: string[];
  hasInstalledModel: (model: string, installed: string[]) => boolean;
  question: string;
  setQuestion: Dispatch<SetStateAction<string>>;
  selectedAnswerModelMissing: boolean;
  askNotes: () => Promise<void>;
  answer: AskResult | null;
  conceptUrl: (id: string) => string;
  formatDate: (value: string) => string;
};

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const {
    sidebarMode,
    setSidebarMode,
    reindexing,
    reindexBundle,
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
    status,
    notes,
    searchInputRef,
    searchQuery,
    setSearchQuery,
    selectedTag,
    searching,
    searchNotes,
    availableTags,
    setSelectedTag,
    setSearchResults,
    searchTag,
    searchResults,
    selectedAnswerModel,
    setAskModel,
    setAnswer,
    asking,
    configuredAnswerModels,
    hasInstalledModel,
    question,
    setQuestion,
    selectedAnswerModelMissing,
    askNotes,
    answer,
    conceptUrl,
    formatDate,
  } = props;
  return (
    <aside className="workbench-sidebar">
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
          <>
            <div className="sidebar-heading">
              <span>Explorer</span>
              <button
                type="button"
                onClick={reindexBundle}
                disabled={reindexing}
                title="Reread Markdown and rebuild search and relationships"
              >
                {reindexing ? "..." : "Reindex"}
              </button>
            </div>
            <div className="tree-scroll">
              {filesLoading ? (
                <p className="sidebar-empty">Reading bundle...</p>
              ) : (
                <>
                  {localDraftDocuments.length > 0 && (
                    <div className="tree-branch local-drafts">
                      <div
                        className="tree-row tree-directory static"
                        style={{ "--tree-depth": 0 } as React.CSSProperties}
                      >
                        <span className="tree-chevron">v</span>
                        <span className="tree-folder" aria-hidden="true" />
                        <span>Drafts</span>
                        <small>{localDraftDocuments.length}</small>
                      </div>
                      {localDraftDocuments.map((draft) => (
                        <div
                          className="tree-row tree-file draft-tree-row"
                          style={{ "--tree-depth": 1 } as React.CSSProperties}
                          key={draft.id}
                        >
                          <button
                            type="button"
                            className="draft-tree-open"
                            onClick={() => openLocalDraft(draft.id)}
                            title="Local draft"
                          >
                            <span className="tree-file-mark">D</span>
                            <span>
                              {draftTitle(drafts[draft.id] ?? draft.content)}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="draft-tree-delete"
                            onClick={() => void deleteLocalDraft(draft.id)}
                            disabled={
                              deletingDraftIds.has(draft.id) ||
                              savingDocuments.has(draft.id)
                            }
                            title="Delete draft"
                            aria-label={`Delete ${draftTitle(drafts[draft.id] ?? draft.content)}`}
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <FileTree
                    directory={fileTree}
                    depth={0}
                    expanded={expandedDirectories}
                    draggedFileId={draggedFileId}
                    dropDirectoryPath={dropDirectoryPath}
                    movingFileId={movingFileId}
                    blockedFileIds={blockedFileIds}
                    onToggle={(path) =>
                      setExpandedDirectories((current: Set<string>) => {
                        const next = new Set(current);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                    onOpen={(id, disposition) =>
                      void openDocument(id, "file", undefined, disposition)
                    }
                    onFileDragStart={setDraggedFileId}
                    onFileDragEnd={() => {
                      setDraggedFileId(null);
                      setDropDirectoryPath(null);
                    }}
                    onDirectoryDragOver={setDropDirectoryPath}
                    onMove={(id, directory) =>
                      void moveBundleFile(id, directory)
                    }
                  />
                </>
              )}
            </div>
          </>
        ) : sidebarMode === "search" ? (
          <>
            <div className="sidebar-heading">
              <span>Search</span>
              <small>
                {status?.embeddingCoverage?.refreshing
                  ? "Indexing"
                  : `${notes.length} notes`}
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
                  <strong>{result.title}</strong>
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
              <select
                value={selectedAnswerModel}
                onChange={(event) => {
                  setAskModel(event.target.value);
                  setAnswer(null);
                }}
                disabled={asking || !configuredAnswerModels.length}
                aria-label="Answer model"
              >
                {configuredAnswerModels.map((model) => (
                  <option
                    key={model}
                    value={model}
                    disabled={Boolean(
                      status?.online &&
                        !hasInstalledModel(model, status.installed),
                    )}
                  >
                    {model}
                  </option>
                ))}
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

      <section className="recent-panel">
        <div className="sidebar-heading">
          <span>Recent concepts</span>
          <small>{notes.length}</small>
        </div>
        <div className="recent-list">
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
