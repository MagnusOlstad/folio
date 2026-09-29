import type { NoteHistorySnapshot, ViewerDocument } from "../../../domain/types.ts";
import { RenderedMarkdown } from "./RenderedMarkdown.tsx";

type Props = {
  document: ViewerDocument;
  snapshot: NoteHistorySnapshot | null;
  loading: boolean;
  failed: boolean;
  presentContent: string;
};

export function HistoryDocumentView({ document, snapshot, loading, failed, presentContent }: Props) {
  const preview: ViewerDocument = {
    ...document,
    content: presentContent,
    ...(snapshot?.note ?? {}),
    deletable: false,
    movable: false,
  };
  return <article className="document-view history-document-view" role="region" aria-label="History preview">
    <div className="document-scroll">
      <div className="history-preview-banner"><span>HISTORY PREVIEW</span><span>Read only</span></div>
      {loading ? <div className="history-preview-loading" role="status">Opening this moment…</div> : failed ? <div className="history-preview-loading" role="alert">Could not open this moment. Select its tick to try again.</div> : <>
        <header className="document-heading"><p>{preview.type} / {snapshot ? "earlier moment" : "current note"}</p><h1>{preview.title}</h1>{preview.description && <span className="history-preview-description">{preview.description}</span>}</header>
        <div className="document-content read-only">
          <RenderedMarkdown document={preview} groupId="" saving={false} onOpenDocument={async () => {}} onToggleTask={async () => {}} />
        </div>
      </>}
    </div>
    <div className="history-preview-footer">Previewing history · use Done to return to your note</div>
  </article>;
}
