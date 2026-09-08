import { useLayoutEffect, useRef } from "react";
import type { ViewerDocument } from "../../../domain/types.ts";
import { isUntitledId } from "../../../lib/workspace.ts";
import { DocumentBody } from "./DocumentBody.tsx";
import { DocumentFooter } from "./DocumentFooter.tsx";
import { DocumentHeader } from "./DocumentHeader.tsx";
import type { MetadataField } from "../types.ts";

export type DocumentViewProps = {
  groupId: string;
  document: ViewerDocument;
  editKey: string;
  draft: string | undefined;
  saving: boolean;
  deletingNoteId: string | null;
  movingFileId: string | null;
  editingMetadataKey: string | null;
  metadataDrafts: Record<string, string>;
  pathDraft: string | undefined;
  tagDraft: string | undefined;
  getScrollTop: (documentId: string) => number;
  onScroll: (documentId: string, scrollTop: number) => void;
  onBeginMetadataEditing: (
    groupId: string,
    document: ViewerDocument,
    field: MetadataField,
    saving: boolean,
  ) => void;
  onChangeMetadataDraft: (key: string, value: string) => void;
  onFinishMetadataEditing: (
    key: string,
    document: ViewerDocument,
    field: MetadataField,
    value: string,
  ) => void;
  onChangeContent: (document: ViewerDocument, content: string) => void;
  onFileDraft: (document: ViewerDocument) => void;
  onBeginEditing: (
    groupId: string,
    document: ViewerDocument,
  ) => void;
  onFinishEditing: (
    groupId: string,
    document: ViewerDocument,
    scrollTop?: number,
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
  onBeginPathEditing: (document: ViewerDocument) => void;
  onChangePath: (documentId: string, value: string) => void;
  onFinishPathEditing: (document: ViewerDocument, value: string) => void;
  onResetPath: (document: ViewerDocument) => void;
  onBeginTagEditing: (document: ViewerDocument) => void;
  onChangeTag: (documentId: string, value: string) => void;
  onFinishTagEditing: (document: ViewerDocument, value: string) => void;
  onDelete: (document: ViewerDocument) => Promise<void>;
};

export function DocumentView(props: DocumentViewProps) {
  const { document, getScrollTop, onScroll } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = getScrollTop(document.id);
  }, [document.id, getScrollTop]);

  return (
    <article
      className={`document-view ${isUntitledId(document.id) ? "untitled" : ""}`}
    >
      <div
        className="document-scroll"
        data-document-scroll
        ref={scrollRef}
        onScroll={(event) =>
          onScroll(document.id, event.currentTarget.scrollTop)
        }
      >
        {!isUntitledId(document.id) && (
          <DocumentHeader
            groupId={props.groupId}
            document={document}
            saving={props.saving}
            editingKey={props.editingMetadataKey}
            drafts={props.metadataDrafts}
            onBeginEditing={props.onBeginMetadataEditing}
            onChangeDraft={props.onChangeMetadataDraft}
            onFinishEditing={props.onFinishMetadataEditing}
          />
        )}
        <DocumentBody
          groupId={props.groupId}
          document={document}
          editKey={props.editKey}
          draft={props.draft}
          saving={props.saving}
          onChangeContent={props.onChangeContent}
          onFileDraft={props.onFileDraft}
          onFinishEditing={props.onFinishEditing}
          onBeginEditing={props.onBeginEditing}
          onOpenDocument={props.onOpenDocument}
          onToggleTask={props.onToggleTask}
        />
      </div>
      <div className="document-find-layer" data-document-find-layer />
      <DocumentFooter
        groupId={props.groupId}
        document={document}
        draft={props.draft}
        pathDraft={props.pathDraft}
        tagDraft={props.tagDraft}
        saving={props.saving}
        deleting={props.deletingNoteId === document.id}
        deleteInProgress={Boolean(props.deletingNoteId)}
        moving={props.movingFileId === document.id}
        onBeginPathEditing={props.onBeginPathEditing}
        onChangePath={props.onChangePath}
        onFinishPathEditing={props.onFinishPathEditing}
        onResetPath={props.onResetPath}
        onBeginTagEditing={props.onBeginTagEditing}
        onChangeTag={props.onChangeTag}
        onFinishTagEditing={props.onFinishTagEditing}
        onFileDraft={props.onFileDraft}
        onDelete={props.onDelete}
        onOpenDocument={props.onOpenDocument}
      />
    </article>
  );
}
