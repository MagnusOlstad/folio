import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { NoteExportSnapshot } from "../model/note-export.ts";
import { folioMarkdown } from "../model/folio-markdown.ts";

type NoteExportPreviewProps = {
  snapshot: NoteExportSnapshot;
};

export function NoteExportPreview({ snapshot }: NoteExportPreviewProps) {
  return (
    <article className="note-export-preview">
      {!snapshot.draft ? (
        <header>
          <h1>{snapshot.title}</h1>
          {snapshot.description ? <p>{snapshot.description}</p> : null}
        </header>
      ) : null}
      <ReactMarkdown remarkPlugins={[folioMarkdown, remarkGfm, remarkBreaks]}>
        {snapshot.content}
      </ReactMarkdown>
    </article>
  );
}
