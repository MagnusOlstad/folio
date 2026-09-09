import { useState } from "react";
import type { ViewerDocument } from "../../../domain/types.ts";
import { directoryForId } from "../../../lib/paths.ts";
import {
  filedDraftContent,
  formatDate,
  isUntitledId,
} from "../../../lib/workspace.ts";
import { NoteDeleteConfirmation } from "./NoteDeleteConfirmation.tsx";

type DocumentFooterProps = {
  groupId: string;
  document: ViewerDocument;
  draft: string | undefined;
  pathDraft: string | undefined;
  tagDraft: string | undefined;
  saving: boolean;
  deleting: boolean;
  deleteInProgress: boolean;
  moving: boolean;
  onBeginPathEditing: (document: ViewerDocument) => void;
  onChangePath: (documentId: string, value: string) => void;
  onFinishPathEditing: (document: ViewerDocument, value: string) => void;
  onResetPath: (document: ViewerDocument) => void;
  onBeginTagEditing: (document: ViewerDocument) => void;
  onChangeTag: (documentId: string, value: string) => void;
  onFinishTagEditing: (document: ViewerDocument, value: string) => void;
  onFileDraft: (document: ViewerDocument) => void;
  onDelete: (document: ViewerDocument) => Promise<void>;
  onOpenDocument: (
    id: string,
    source?: "note" | "file",
    targetGroupId?: string,
  ) => Promise<void>;
};

export function DocumentFooter({
  groupId,
  document,
  draft,
  pathDraft,
  tagDraft,
  saving,
  deleting,
  deleteInProgress,
  moving,
  onBeginPathEditing,
  onChangePath,
  onFinishPathEditing,
  onResetPath,
  onBeginTagEditing,
  onChangeTag,
  onFinishTagEditing,
  onFileDraft,
  onDelete,
  onOpenDocument,
}: DocumentFooterProps) {
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const frontmatterLinks = Array.from(
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
  );
  const footerLinks = frontmatterLinks.slice(0, 6);

  return (
    <footer className="document-footer">
      <div className="document-footer-details">
        <div className="document-path" title={document.id}>
          <span>Path</span>
          {document.movable ? (
            <input
              value={pathDraft ?? directoryForId(document.id)}
              disabled={moving || deleting}
              onFocus={() => onBeginPathEditing(document)}
              onChange={(event) =>
                onChangePath(document.id, event.target.value)
              }
              onBlur={(event) =>
                onFinishPathEditing(document, event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.value = directoryForId(document.id);
                  onResetPath(document);
                  event.currentTarget.blur();
                }
              }}
              aria-label={`Path for ${document.title}`}
            />
          ) : (
            <strong>
              {isUntitledId(document.id) ? "Unfiled" : document.id}
            </strong>
          )}
        </div>
        <div className="document-tags">
          <span>Tags</span>
          {isUntitledId(document.id) ? (
            <strong>Assigned when filed</strong>
          ) : document.deletable ? (
            <input
              value={tagDraft ?? document.tags.join(", ")}
              onFocus={() => onBeginTagEditing(document)}
              onChange={(event) =>
                onChangeTag(document.id, event.target.value)
              }
              onBlur={(event) =>
                onFinishTagEditing(document, event.target.value)
              }
              aria-label={`Tags for ${document.title}`}
            />
          ) : (
            <strong>
              {document.tags.length
                ? document.tags.map((tag) => `#${tag}`).join(" ")
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
              onClick={() => onFileDraft(document)}
              disabled={
                saving || !filedDraftContent(draft || "").trim()
              }
              title="Classify and add to the bundle (Cmd+Enter or Cmd+S)"
            >
              {saving ? "Filing..." : "File note"}
            </button>
          ) : (
            <>
              <strong>
                {deleting
                  ? "Deleting..."
                  : document.deletable
                    ? "Saved"
                    : "Read only"}
              </strong>
              {document.deletable && (
                <button
                  type="button"
                  className="document-delete"
                  onClick={() => setDeleteConfirmationId(document.id)}
                  disabled={deleteInProgress}
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
          <span>Links {frontmatterLinks.length}</span>
          <div className="document-footer-link-list">
            {footerLinks.map((link) => (
              <button
                type="button"
                className="document-footer-link"
                onClick={() =>
                  void onOpenDocument(link.id, "file", groupId)
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
      {deleteConfirmationId === document.id && (
        <NoteDeleteConfirmation
          title={document.title}
          deleting={deleting}
          onCancel={() => setDeleteConfirmationId(null)}
          onConfirm={() => void onDelete(document)}
        />
      )}
    </footer>
  );
}
