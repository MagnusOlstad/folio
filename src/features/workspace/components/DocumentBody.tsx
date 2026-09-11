import type { ViewerDocument } from "../../../domain/types.ts";
import { resolveBundleLink } from "../../../lib/paths.ts";
import { isUntitledId, toggleTaskAtLine } from "../../../lib/workspace.ts";
import { DraftMarkdownEditor } from "./DraftMarkdownEditor.tsx";
import { LiveMarkdownEditor } from "./LiveMarkdownEditor.tsx";
import { RenderedMarkdown } from "./RenderedMarkdown.tsx";

type DocumentBodyProps = {
  groupId: string;
  document: ViewerDocument;
  editKey: string;
  draft: string | undefined;
  saving: boolean;
  focusRequestId?: number;
  onFocusRequestConsumed?: () => void;
  onChangeContent: (document: ViewerDocument, content: string) => void;
  onFileDraft: (document: ViewerDocument) => void;
  onFinishEditing: (
    groupId: string,
    document: ViewerDocument,
    scrollTop?: number,
  ) => void;
  onBeginEditing: (
    groupId: string,
    document: ViewerDocument,
  ) => void;
  onOpenDocument: (
    id: string,
    source?: "note" | "file",
    targetGroupId?: string,
  ) => Promise<void>;
  onToggleTask: (
    document: ViewerDocument,
    lineNumber: number,
    checked: boolean,
  ) => Promise<void>;
};

export function DocumentBody({
  groupId,
  document,
  editKey,
  draft,
  saving,
  focusRequestId,
  onFocusRequestConsumed,
  onChangeContent,
  onFileDraft,
  onFinishEditing,
  onBeginEditing,
  onOpenDocument,
  onToggleTask,
}: DocumentBodyProps) {
  if (isUntitledId(document.id)) {
    return (
      <DraftMarkdownEditor
        key={editKey}
        value={draft ?? document.content}
        onChange={(content) => onChangeContent(document, content)}
        onFile={() => onFileDraft(document)}
        onOpenLink={(href) => {
          const linkedFile = resolveBundleLink(document.id, href);
          if (linkedFile) {
            void onOpenDocument(linkedFile, "file", groupId);
            return;
          }
          window.open(href, "_blank", "noopener,noreferrer");
        }}
        onToggleTask={(lineNumber, checked) => {
          const content = toggleTaskAtLine(draft ?? document.content, lineNumber, checked);
          if (content) onChangeContent(document, content);
        }}
        focusRequestId={focusRequestId}
        onFocusRequestConsumed={onFocusRequestConsumed}
        ariaLabel="Write a new note"
      />
    );
  }

  if (document.deletable) {
    const value = draft ?? document.content;
    return (
      <LiveMarkdownEditor
        key={editKey}
        value={value}
        onChange={(content) => onChangeContent(document, content)}
        onFocus={() => onBeginEditing(groupId, document)}
        onBlur={(scrollTop) =>
          onFinishEditing(groupId, document, scrollTop)
        }
        onOpenLink={(href) => {
          const linkedFile = resolveBundleLink(document.id, href);
          if (linkedFile) {
            void onOpenDocument(linkedFile, "file", groupId);
            return;
          }
          window.open(href, "_blank", "noopener,noreferrer");
        }}
        onToggleTask={(lineNumber, checked) => {
          const content = toggleTaskAtLine(value, lineNumber, checked);
          if (content) onChangeContent(document, content);
        }}
        focusRequestId={focusRequestId}
        onFocusRequestConsumed={onFocusRequestConsumed}
        ariaLabel={`Edit ${document.title}`}
      />
    );
  }

  return (
    <div
      className="document-content read-only"
      title="Read-only file"
    >
      <RenderedMarkdown
        document={document}
        groupId={groupId}
        saving={saving}
        onOpenDocument={onOpenDocument}
        onToggleTask={onToggleTask}
      />
    </div>
  );
}
