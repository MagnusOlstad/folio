import type {
  EditorIntent,
  ViewerDocument,
} from "../../../domain/types.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import { NoteEditor } from "../../editor/NoteEditor.tsx";
import { RenderedMarkdown } from "./RenderedMarkdown.tsx";

type DocumentBodyProps = {
  groupId: string;
  document: ViewerDocument;
  editKey: string;
  isEditing: boolean;
  editorIntent?: EditorIntent;
  draft: string | undefined;
  saving: boolean;
  onRestoreScroll: (editKey: string, element: HTMLDivElement) => void;
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
    intent?: EditorIntent,
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
  isEditing,
  editorIntent,
  draft,
  saving,
  onRestoreScroll,
  onChangeContent,
  onFileDraft,
  onFinishEditing,
  onBeginEditing,
  onOpenDocument,
  onToggleTask,
}: DocumentBodyProps) {
  if (isUntitledId(document.id)) {
    return (
      <NoteEditor
        key={editKey}
        value={draft ?? document.content}
        onChange={(content) => onChangeContent(document, content)}
        onBlur={() => undefined}
        onFile={() => onFileDraft(document)}
        steered
        ariaLabel="Write a new note"
      />
    );
  }

  if (isEditing) {
    return (
      <NoteEditor
        key={editKey}
        value={draft ?? document.content}
        onChange={(content) => onChangeContent(document, content)}
        onBlur={(scrollTop) =>
          onFinishEditing(groupId, document, scrollTop)
        }
        intent={editorIntent}
        ariaLabel={`Edit ${document.title}`}
      />
    );
  }

  return (
    <div
      className={`document-content ${document.deletable ? "editable" : "read-only"}`}
      ref={(element) => {
        if (!element) return;
        onRestoreScroll(editKey, element);
      }}
      onClick={(event) => {
        if ((event.target as Element).closest("a, button, input")) return;
        const source = (event.target as Element).closest<HTMLElement>(
          "[data-source-line]",
        );
        const startLine = Number(source?.dataset.sourceLine) || 1;
        const endLine = Number(source?.dataset.sourceEndLine) || startLine;
        const lineHeight = source
          ? Number.parseFloat(window.getComputedStyle(source).lineHeight) || 32
          : 32;
        const visualLine = source
          ? Math.max(
              0,
              Math.floor(
                (event.clientY - source.getBoundingClientRect().top) /
                  lineHeight,
              ),
            )
          : 0;
        onBeginEditing(groupId, document, {
          lineNumber: Math.min(endLine, startLine + visualLine),
          scrollTop: event.currentTarget.scrollTop,
        });
      }}
      title={document.deletable ? "Click to edit" : "Read-only file"}
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
