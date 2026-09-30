import type { NoteHistorySnapshot, ViewerDocument } from "../../../domain/types.ts";
import { useLayoutEffect, useRef } from "react";
import { isUntitledId } from "../../../lib/workspace.ts";
import { DocumentHeader } from "./DocumentHeader.tsx";
import { RenderedMarkdown } from "./RenderedMarkdown.tsx";

type Props = {
  document: ViewerDocument;
  snapshot: NoteHistorySnapshot | null;
  loading: boolean;
  failed: boolean;
  presentContent: string;
};

function historyPreviewContent(content: string) {
  return content.replace(/^# Captured note[ \t]*\r?\n(?:[ \t]*\r?\n)*(?=<!-- folio:capture:[^:\r\n]+:start -->)/, "");
}

export function HistoryDocumentView({ document, snapshot, loading, failed, presentContent }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const alignedScroll = useRef(false);
  const preview: ViewerDocument = {
    ...document,
    ...(snapshot?.note ?? {}),
    content: historyPreviewContent(snapshot?.note.content ?? presentContent),
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
    <div ref={scrollRef} className="document-scroll" data-document-scroll="">
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
      {!failed || snapshot ? <div className="document-content read-only history-document-content">
        <RenderedMarkdown document={preview} groupId="" saving={false} onOpenDocument={async () => {}} onToggleTask={async () => {}} />
      </div> : null}
    </div>
  </article>;
}
