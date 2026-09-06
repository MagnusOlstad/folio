import { Fragment } from "react";
import type {
  Dispatch,
  MutableRefObject,
  PointerEvent,
  SetStateAction,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type {
  EditorIntent,
  MarkdownNode,
  TabGroup,
  ViewerDocument,
} from "../../domain/types.ts";
import { NoteEditor } from "../editor/NoteEditor.tsx";
import { EditorTabs } from "../tabs/EditorTabs.tsx";

type TabDrag = { documentId: string; groupId: string };
type MetadataField = "title" | "description";
type SourcePosition = {
  "data-source-line": number | undefined;
  "data-source-end-line": number | undefined;
};

export type EditorWorkspaceProps = {
  groups: TabGroup[];
  splitPosition: number;
  beginHorizontalResize: (event: PointerEvent<HTMLElement>) => void;
  resizeSplit: (clientX: number, handle: HTMLElement) => void;
  finishHorizontalResize: (event: PointerEvent<HTMLElement>) => void;
  setSplitPosition: Dispatch<SetStateAction<number>>;
  activeGroupId: string;
  dropGroupId: string | null;
  draggedTab: TabDrag | null;
  setActiveGroupId: Dispatch<SetStateAction<string>>;
  setDropGroupId: Dispatch<SetStateAction<string | null>>;
  moveTabToGroup: (
    documentId: string,
    sourceGroupId: string,
    targetGroupId: string,
  ) => void;
  setDraggedTab: Dispatch<SetStateAction<TabDrag | null>>;
  savingDocuments: Set<string>;
  titleForId: (id: string) => string;
  isUntitledId: (id: string) => boolean;
  activateTab: (groupId: string, documentId: string) => void;
  createNewTab: (targetGroupId?: string) => void;
  splitWorkspace: () => void;
  closeGroup: (groupId: string) => void;
  closeTab: (groupId: string, documentId: string) => void;
  documents: Record<string, ViewerDocument>;
  loadingDocuments: Set<string>;
  editingKey: string | null;
  editorIntents: MutableRefObject<Record<string, EditorIntent>>;
  metadataDrafts: Record<string, string>;
  setMetadataDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  finishMetadataEditing: (
    key: string,
    document: ViewerDocument,
    field: MetadataField,
    value: string,
  ) => void;
  beginMetadataEditing: (
    groupId: string,
    document: ViewerDocument,
    field: MetadataField,
  ) => void;
  beginEditing: (
    groupId: string,
    document: ViewerDocument,
    intent?: EditorIntent,
  ) => void;
  drafts: Record<string, string>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setDocuments: Dispatch<SetStateAction<Record<string, ViewerDocument>>>;
  fileDraft: (document: ViewerDocument) => void;
  finishEditing: (
    groupId: string,
    document: ViewerDocument,
    scrollTop?: number,
  ) => void;
  readerScrollPositions: MutableRefObject<Record<string, number>>;
  openDocument: (
    id: string,
    source?: "note" | "file",
    targetGroupId?: string,
  ) => Promise<void>;
  resolveBundleLink: (currentId: string, href?: string) => string | null;
  conceptUrl: (id: string) => string;
  sourcePosition: (node?: MarkdownNode) => SourcePosition;
  toggleTaskCheckbox: (
    document: ViewerDocument,
    lineNumber: number,
    checked: boolean,
  ) => Promise<void>;
  formatDate: (value: string) => string;
  deleteFiledNote: (document: ViewerDocument) => Promise<void>;
  deletingNoteId: string | null;
  pathDrafts: Record<string, string>;
  setPathDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  tagDrafts: Record<string, string>;
  setTagDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  persistDocument: (
    document: ViewerDocument,
    nextContent: string,
    nextTags: string[],
  ) => void;
  editingMetadataKey: string | null;
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  directoryForId: (id: string) => string;
  normalizeDirectoryInput: (value: string) => string;
  movingFileId: string | null;
  moveBundleFile: (id: string, directory: string) => Promise<void>;
  parseTags: (value: string) => string[];
  filedDraftContent: (value: string) => string;
};
export function EditorWorkspace(props: EditorWorkspaceProps) {
  const {
    groups,
    splitPosition,
    beginHorizontalResize,
    resizeSplit,
    finishHorizontalResize,
    setSplitPosition,
    activeGroupId,
    dropGroupId,
    draggedTab,
    setActiveGroupId,
    setDropGroupId,
    moveTabToGroup,
    setDraggedTab,
    savingDocuments,
    titleForId,
    isUntitledId,
    activateTab,
    createNewTab,
    splitWorkspace,
    closeGroup,
    closeTab,
    documents,
    loadingDocuments,
    editingKey,
    editorIntents,
    metadataDrafts,
    setMetadataDrafts,
    finishMetadataEditing,
    beginMetadataEditing,
    beginEditing,
    drafts,
    setDrafts,
    setDocuments,
    fileDraft,
    finishEditing,
    readerScrollPositions,
    openDocument,
    resolveBundleLink,
    conceptUrl,
    sourcePosition,
    toggleTaskCheckbox,
    formatDate,
    deleteFiledNote,
    deletingNoteId,
    pathDrafts,
    setPathDrafts,
    tagDrafts,
    setTagDrafts,
    persistDocument,
    editingMetadataKey,
    message,
    setMessage,
    directoryForId,
    normalizeDirectoryInput,
    movingFileId,
    moveBundleFile,
    parseTags,
    filedDraftContent,
  } = props;
  return (
    <section
      className={`editor-workspace ${groups.length === 2 ? "is-split" : ""}`}
      style={{ "--split-position": `${splitPosition}%` } as React.CSSProperties}
    >
      {groups.map((group, groupIndex) => {
        const document = group.activeId ? documents[group.activeId] : null;
        const isLoading = Boolean(
          group.activeId && loadingDocuments.has(group.activeId),
        );
        const editKey = document ? `${group.id}:${document.id}` : "";
        const isEditing = editingKey === editKey;
        const editorIntent = editorIntents.current[editKey];
        const frontmatterLinks = document
          ? Array.from(
              new Map(
                document.links
                  .filter(
                    (link) =>
                      link.origin === "frontmatter" &&
                      !link.id.startsWith("/references/inbox/"),
                  )
                  .map((link) => [link.id, link]),
              ).values(),
            ).sort(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) ||
                left.title.localeCompare(right.title),
            )
          : [];
        const footerLinks = frontmatterLinks.slice(0, 6);
        const frontmatterLinkCount = frontmatterLinks.length;
        return (
          <Fragment key={group.id}>
            {groupIndex === 1 && (
              <div
                className="horizontal-resize-handle split-resize-handle"
                role="separator"
                tabIndex={0}
                aria-label="Resize split notes"
                aria-orientation="vertical"
                aria-valuemin={20}
                aria-valuemax={80}
                aria-valuenow={Math.round(splitPosition)}
                onPointerDown={beginHorizontalResize}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    resizeSplit(event.clientX, event.currentTarget);
                }}
                onPointerUp={finishHorizontalResize}
                onPointerCancel={finishHorizontalResize}
                onDoubleClick={() => setSplitPosition(50)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                    return;
                  event.preventDefault();
                  const workspace = event.currentTarget.parentElement;
                  if (!workspace) return;
                  const bounds = workspace.getBoundingClientRect();
                  const availableWidth =
                    bounds.width - event.currentTarget.offsetWidth;
                  const nextPosition =
                    splitPosition + (event.key === "ArrowLeft" ? -2 : 2);
                  resizeSplit(
                    bounds.left + (availableWidth * nextPosition) / 100,
                    event.currentTarget,
                  );
                }}
              />
            )}
            <section
              className={`editor-group ${activeGroupId === group.id ? "active" : ""} ${dropGroupId === group.id ? "drop-target" : ""}`}
              onMouseDown={() => setActiveGroupId(group.id)}
              onDragOver={(event) => {
                if (!draggedTab) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropGroupId(group.id);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node))
                  setDropGroupId(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const payload = event.dataTransfer.getData(
                  "application/x-folio-tab",
                );
                let tab = draggedTab;
                if (payload) {
                  try {
                    const parsed = JSON.parse(payload) as {
                      documentId?: unknown;
                      groupId?: unknown;
                    };
                    if (
                      typeof parsed.documentId === "string" &&
                      typeof parsed.groupId === "string"
                    ) {
                      tab = {
                        documentId: parsed.documentId,
                        groupId: parsed.groupId,
                      };
                    }
                  } catch {
                    tab = null;
                  }
                }
                if (tab) moveTabToGroup(tab.documentId, tab.groupId, group.id);
                setDraggedTab(null);
                setDropGroupId(null);
              }}
            >
              <EditorTabs
                group={group}
                groupCount={groups.length}
                savingDocumentIds={savingDocuments}
                titleForId={titleForId}
                isUntitledId={isUntitledId}
                onActivate={activateTab}
                onDragStart={(event, id, groupId) => {
                  const payload = { documentId: id, groupId };
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(
                    "application/x-folio-tab",
                    JSON.stringify(payload),
                  );
                  setDraggedTab(payload);
                }}
                onDragEnd={() => {
                  setDraggedTab(null);
                  setDropGroupId(null);
                }}
                onCloseTab={closeTab}
                onNewTab={createNewTab}
                onSplit={splitWorkspace}
                onCloseGroup={closeGroup}
              />

              <div className="editor-surface">
                {isLoading ? (
                  <div className="editor-placeholder">
                    <span>Opening file...</span>
                  </div>
                ) : document ? (
                  <article
                    className={`document-view ${isUntitledId(document.id) ? "untitled" : ""}`}
                  >
                    {!isUntitledId(document.id) && (
                      <header className="document-heading">
                        <p>
                          {document.type}
                          {document.stale ? " / stale" : ""}
                        </p>
                        {editingMetadataKey ===
                        `${group.id}:${document.id}:title` ? (
                          <input
                            className="document-title-editor"
                            value={
                              metadataDrafts[
                                `${group.id}:${document.id}:title`
                              ] ?? document.title
                            }
                            onChange={(event) =>
                              setMetadataDrafts((current) => ({
                                ...current,
                                [`${group.id}:${document.id}:title`]:
                                  event.target.value,
                              }))
                            }
                            onBlur={(event) =>
                              finishMetadataEditing(
                                `${group.id}:${document.id}:title`,
                                document,
                                "title",
                                event.currentTarget.value,
                              )
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter")
                                event.currentTarget.blur();
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.currentTarget.value = document.title;
                                event.currentTarget.blur();
                              }
                            }}
                            aria-label={`Title for ${document.title}`}
                            autoFocus
                          />
                        ) : document.movable ? (
                          <button
                            type="button"
                            className="document-title"
                            onClick={() =>
                              beginMetadataEditing(group.id, document, "title")
                            }
                            disabled={savingDocuments.has(document.id)}
                            title="Click to edit title"
                          >
                            {document.title}
                          </button>
                        ) : (
                          <h1>{document.title}</h1>
                        )}
                        {editingMetadataKey ===
                        `${group.id}:${document.id}:description` ? (
                          <input
                            className="document-description-editor"
                            value={
                              metadataDrafts[
                                `${group.id}:${document.id}:description`
                              ] ?? document.description
                            }
                            onChange={(event) =>
                              setMetadataDrafts((current) => ({
                                ...current,
                                [`${group.id}:${document.id}:description`]:
                                  event.target.value,
                              }))
                            }
                            onBlur={(event) =>
                              finishMetadataEditing(
                                `${group.id}:${document.id}:description`,
                                document,
                                "description",
                                event.currentTarget.value,
                              )
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter")
                                event.currentTarget.blur();
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.currentTarget.value =
                                  document.description;
                                event.currentTarget.blur();
                              }
                            }}
                            aria-label={`Description for ${document.title}`}
                            autoFocus
                          />
                        ) : document.deletable ? (
                          <button
                            type="button"
                            className={`document-description ${document.description ? "" : "empty"}`}
                            onClick={() =>
                              beginMetadataEditing(
                                group.id,
                                document,
                                "description",
                              )
                            }
                            disabled={savingDocuments.has(document.id)}
                            title="Click to edit description"
                          >
                            {document.description || "Add description"}
                          </button>
                        ) : document.description ? (
                          <span>{document.description}</span>
                        ) : null}
                      </header>
                    )}
                    {isUntitledId(document.id) ? (
                      <NoteEditor
                        key={editKey}
                        value={drafts[document.id] ?? document.content}
                        onChange={(content) => {
                          setDrafts((current) => ({
                            ...current,
                            [document.id]: content,
                          }));
                          setDocuments((current) => ({
                            ...current,
                            [document.id]: {
                              ...current[document.id],
                              content,
                              updatedAt: new Date().toISOString(),
                            },
                          }));
                        }}
                        onBlur={() => undefined}
                        onFile={() => fileDraft(document)}
                        steered
                        ariaLabel="Write a new note"
                      />
                    ) : isEditing ? (
                      <NoteEditor
                        key={editKey}
                        value={drafts[document.id] ?? document.content}
                        onChange={(content) =>
                          setDrafts((current) => ({
                            ...current,
                            [document.id]: content,
                          }))
                        }
                        onBlur={(scrollTop) =>
                          finishEditing(group.id, document, scrollTop)
                        }
                        intent={editorIntent}
                        ariaLabel={`Edit ${document.title}`}
                      />
                    ) : (
                      <div
                        className={`document-content ${document.deletable ? "editable" : "read-only"}`}
                        ref={(element) => {
                          if (!element) return;
                          const scrollTop =
                            readerScrollPositions.current[editKey];
                          if (scrollTop === undefined) return;
                          element.scrollTop = scrollTop;
                          delete readerScrollPositions.current[editKey];
                        }}
                        onClick={(event) => {
                          if (
                            (event.target as Element).closest(
                              "a, button, input",
                            )
                          )
                            return;
                          const source = (
                            event.target as Element
                          ).closest<HTMLElement>("[data-source-line]");
                          const startLine =
                            Number(source?.dataset.sourceLine) || 1;
                          const endLine =
                            Number(source?.dataset.sourceEndLine) || startLine;
                          const lineHeight = source
                            ? Number.parseFloat(
                                window.getComputedStyle(source).lineHeight,
                              ) || 32
                            : 32;
                          const visualLine = source
                            ? Math.max(
                                0,
                                Math.floor(
                                  (event.clientY -
                                    source.getBoundingClientRect().top) /
                                    lineHeight,
                                ),
                              )
                            : 0;
                          beginEditing(group.id, document, {
                            lineNumber: Math.min(
                              endLine,
                              startLine + visualLine,
                            ),
                            scrollTop: event.currentTarget.scrollTop,
                          });
                        }}
                        title={
                          document.deletable
                            ? "Click to edit"
                            : "Read-only file"
                        }
                      >
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                          components={{
                            a: ({ href, children }) => {
                              const linkedFile = resolveBundleLink(
                                document.id,
                                href,
                              );
                              return linkedFile ? (
                                <a
                                  href={conceptUrl(linkedFile)}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    void openDocument(
                                      linkedFile,
                                      "file",
                                      group.id,
                                    );
                                  }}
                                >
                                  {children}
                                </a>
                              ) : (
                                <a href={href}>{children}</a>
                              );
                            },
                            p: ({ node, ...props }) => (
                              <p {...props} {...sourcePosition(node)} />
                            ),
                            h1: ({ node, ...props }) => (
                              <h1 {...props} {...sourcePosition(node)} />
                            ),
                            h2: ({ node, ...props }) => (
                              <h2 {...props} {...sourcePosition(node)} />
                            ),
                            h3: ({ node, ...props }) => (
                              <h3 {...props} {...sourcePosition(node)} />
                            ),
                            h4: ({ node, ...props }) => (
                              <h4 {...props} {...sourcePosition(node)} />
                            ),
                            h5: ({ node, ...props }) => (
                              <h5 {...props} {...sourcePosition(node)} />
                            ),
                            h6: ({ node, ...props }) => (
                              <h6 {...props} {...sourcePosition(node)} />
                            ),
                            blockquote: ({ node, ...props }) => (
                              <blockquote
                                {...props}
                                {...sourcePosition(node)}
                              />
                            ),
                            pre: ({ node, ...props }) => (
                              <pre {...props} {...sourcePosition(node)} />
                            ),
                            li: ({ node, ...props }) => (
                              <li {...props} {...sourcePosition(node)} />
                            ),
                            table: ({ node, ...props }) => (
                              <table {...props} {...sourcePosition(node)} />
                            ),
                            input: ({ node: _node, ...props }) => (
                              <input
                                {...props}
                                disabled={
                                  props.type !== "checkbox" ||
                                  !document.deletable ||
                                  savingDocuments.has(document.id)
                                }
                                onChange={(event) => {
                                  const lineNumber = Number(
                                    event.currentTarget.closest("li")?.dataset
                                      .sourceLine,
                                  );
                                  if (lineNumber)
                                    void toggleTaskCheckbox(
                                      document,
                                      lineNumber,
                                      event.currentTarget.checked,
                                    );
                                }}
                              />
                            ),
                          }}
                        >
                          {document.content}
                        </ReactMarkdown>
                      </div>
                    )}
                    <footer className="document-footer">
                      <div className="document-footer-details">
                        <div className="document-path" title={document.id}>
                          <span>Path</span>
                          {document.movable ? (
                            <input
                              value={
                                pathDrafts[document.id] ??
                                directoryForId(document.id)
                              }
                              disabled={
                                movingFileId === document.id ||
                                savingDocuments.has(document.id) ||
                                deletingNoteId === document.id
                              }
                              onFocus={() =>
                                setPathDrafts((current) => ({
                                  ...current,
                                  [document.id]: directoryForId(document.id),
                                }))
                              }
                              onChange={(event) =>
                                setPathDrafts((current) => ({
                                  ...current,
                                  [document.id]: event.target.value,
                                }))
                              }
                              onBlur={(event) => {
                                const directory = normalizeDirectoryInput(
                                  event.target.value,
                                );
                                setPathDrafts((current) => {
                                  const next = { ...current };
                                  delete next[document.id];
                                  return next;
                                });
                                if (directory !== directoryForId(document.id))
                                  void moveBundleFile(document.id, directory);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter")
                                  event.currentTarget.blur();
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  event.currentTarget.value = directoryForId(
                                    document.id,
                                  );
                                  setPathDrafts((current) => ({
                                    ...current,
                                    [document.id]: directoryForId(document.id),
                                  }));
                                  event.currentTarget.blur();
                                }
                              }}
                              aria-label={`Path for ${document.title}`}
                            />
                          ) : (
                            <strong>
                              {isUntitledId(document.id)
                                ? "Unfiled"
                                : document.id}
                            </strong>
                          )}
                        </div>
                        <div className="document-tags">
                          <span>Tags</span>
                          {isUntitledId(document.id) ? (
                            <strong>Assigned when filed</strong>
                          ) : document.deletable ? (
                            <input
                              value={
                                tagDrafts[document.id] ??
                                document.tags.join(", ")
                              }
                              onFocus={() =>
                                setTagDrafts((current) => ({
                                  ...current,
                                  [document.id]: document.tags.join(", "),
                                }))
                              }
                              onChange={(event) =>
                                setTagDrafts((current) => ({
                                  ...current,
                                  [document.id]: event.target.value,
                                }))
                              }
                              onBlur={(event) => {
                                const tags = parseTags(event.target.value);
                                setTagDrafts((current) => {
                                  const next = { ...current };
                                  delete next[document.id];
                                  return next;
                                });
                                if (
                                  tags.join("\0") !== document.tags.join("\0")
                                )
                                  persistDocument(
                                    document,
                                    document.content,
                                    tags,
                                  );
                              }}
                              aria-label={`Tags for ${document.title}`}
                            />
                          ) : (
                            <strong>
                              {document.tags.length
                                ? document.tags
                                    .map((tag) => `#${tag}`)
                                    .join(" ")
                                : "None"}
                            </strong>
                          )}
                        </div>
                        <div>
                          <span>Status</span>
                          <strong>{document.status}</strong>
                        </div>
                        <div>
                          <span>Last edited</span>
                          <strong>{formatDate(document.createdAt)}</strong>
                        </div>
                        <div>
                          <span>Filing</span>
                          <strong>
                            {isUntitledId(document.id)
                              ? "Pending"
                              : document.filedBy?.startsWith("human:")
                                ? "Human"
                                : "Agent"}
                          </strong>
                        </div>
                      </div>
                      <div className="save-state">
                        <span>State</span>
                        <div className="save-state-controls">
                          {isUntitledId(document.id) ? (
                            <button
                              type="button"
                              onClick={() => fileDraft(document)}
                              disabled={
                                savingDocuments.has(document.id) ||
                                !filedDraftContent(
                                  drafts[document.id] || "",
                                ).trim()
                              }
                              title="Classify and add to the bundle (Cmd+Enter or Cmd+S)"
                            >
                              {savingDocuments.has(document.id)
                                ? "Filing..."
                                : "File note"}
                            </button>
                          ) : (
                            <>
                              <strong>
                                {savingDocuments.has(document.id)
                                  ? "Saving..."
                                  : deletingNoteId === document.id
                                    ? "Deleting..."
                                    : document.deletable
                                      ? "Saved"
                                      : "Read only"}
                              </strong>
                              {document.deletable && (
                                <button
                                  type="button"
                                  className="document-delete"
                                  onClick={() => void deleteFiledNote(document)}
                                  disabled={
                                    Boolean(deletingNoteId) ||
                                    savingDocuments.has(document.id)
                                  }
                                  title={`Delete ${document.title}`}
                                >
                                  Delete
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {footerLinks.length > 0 && (
                        <div className="document-footer-links">
                          <span>Links {frontmatterLinkCount}</span>
                          <div className="document-footer-link-list">
                            {footerLinks.map((link) => (
                              <button
                                type="button"
                                className="document-footer-link"
                                onClick={() =>
                                  void openDocument(link.id, "file", group.id)
                                }
                                title={`${link.relation} / ${formatDate(link.createdAt)}`}
                                key={link.id}
                              >
                                <strong>{link.title}</strong>
                                <small>{formatDate(link.createdAt)}</small>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </footer>
                  </article>
                ) : (
                  <div className="editor-placeholder">
                    <span className="empty-mark">F</span>
                    <h1>Open a note.</h1>
                    <p>
                      Explore the bundle, search by meaning, or ask a question.
                      Every file opens here.
                    </p>
                    <button
                      type="button"
                      className="empty-new-note"
                      onClick={() => createNewTab(group.id)}
                    >
                      New note
                    </button>
                  </div>
                )}
              </div>
            </section>
          </Fragment>
        );
      })}
      {message && (
        <button
          type="button"
          className="workspace-message"
          onClick={() => setMessage("")}
          title="Dismiss"
          role="status"
          aria-live="polite"
        >
          {message}
        </button>
      )}
    </section>
  );
}
