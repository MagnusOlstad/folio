import type { NoteHistorySnapshot, ViewerDocument } from "../../../domain/types.ts";
import { useLayoutEffect, useRef } from "react";
import { isUntitledId } from "../../../lib/workspace.ts";
import { DocumentHeader } from "./DocumentHeader.tsx";
import { LiveMarkdownEditor } from "./LiveMarkdownEditor.tsx";
import { RenderedMarkdown } from "./RenderedMarkdown.tsx";
import { DocumentFooter } from "./DocumentFooter.tsx";

type Props = {
  document: ViewerDocument;
  snapshot: NoteHistorySnapshot | null;
  loading: boolean;
  failed: boolean;
  presentContent: string;
};

export function HistoryDocumentView({ document, snapshot, loading, failed, presentContent }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const alignedScroll = useRef(false);
  const preview: ViewerDocument = {
    ...document,
    ...(snapshot?.note ?? {}),
    content: snapshot?.note.content ?? presentContent,
    deletable: document.deletable,
    movable: document.movable,
  };
  useLayoutEffect(() => {
    if (alignedScroll.current) return;
    const previewScroll = scrollRef.current;
    const liveScroll = previewScroll?.closest(".editor-surface")?.querySelector<HTMLElement>(".history-editor-underlay [data-document-scroll]");
    if (previewScroll && liveScroll) previewScroll.scrollTop = liveScroll.scrollTop;
    alignedScroll.current = true;
  }, []);
  return <article className="document-view history-document-view" role="region" aria-label="History preview">
    <div
      ref={scrollRef}
      className="document-scroll"
      data-document-scroll=""
      onScroll={(event) => {
        const liveScroll = event.currentTarget
          .closest(".editor-surface")
          ?.querySelector<HTMLElement>(".history-editor-underlay [data-document-scroll]");
        if (liveScroll && liveScroll.scrollTop !== event.currentTarget.scrollTop)
          liveScroll.scrollTop = event.currentTarget.scrollTop;
      }}
    >
      {loading && <div className="history-preview-pending" role="status">Loading moment…</div>}
      {failed && !snapshot && <div className="history-preview-loading" role="alert">Could not open this moment. Select its tick to try again.</div>}
      {failed && snapshot && <div className="history-preview-pending is-error" role="alert">Could not open selected moment · showing previous preview</div>}
      {!isUntitledId(document.id) &&
        <DocumentHeader
          groupId="history"
          document={preview}
          editingKey={null}
          drafts={{}}
          onBeginEditing={() => {}}
          onChangeDraft={() => {}}
          onFinishEditing={() => {}}
          readOnly
        />
      }
      {!failed || snapshot ? preview.deletable ? (
          <LiveMarkdownEditor
            value={preview.content}
            onChange={() => {}}
            ariaLabel={`History of ${preview.title}`}
            readOnly
            containerClassName="history-document-content"
          />
        ) : (
          <div className="document-content read-only history-document-content">
            <RenderedMarkdown document={preview} groupId="history" saving={false} onOpenDocument={async () => {}} onToggleTask={async () => {}} />
          </div>
        ) : null}
    </div>
    <DocumentFooter
      groupId="history"
      document={preview}
      draft={undefined}
      pathDraft={undefined}
      tagDraft={undefined}
      saving={false}
      deleting={false}
      deleteInProgress={false}
      moving={false}
      exporting={false}
      readOnly
      onBeginPathEditing={() => {}}
      onChangePath={() => {}}
      onFinishPathEditing={() => {}}
      onResetPath={() => {}}
      onBeginTagEditing={() => {}}
      onChangeTag={() => {}}
      onFinishTagEditing={() => {}}
      onFileDraft={() => {}}
      onDelete={async () => {}}
      onOpenDocument={async () => {}}
      onExport={() => {}}
    />
  </article>;
}
