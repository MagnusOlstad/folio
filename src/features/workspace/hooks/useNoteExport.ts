import { useEffect, useRef, useState } from "react";
import type { ViewerDocument } from "../../../domain/types.ts";
import {
  noteExportFilename,
  noteExportSnapshot,
  type NoteExportFormat,
  type NoteExportSnapshot,
} from "../model/note-export.ts";

type UseNoteExportOptions = {
  setMessage: (message: string) => void;
};

function downloadMarkdown(filename: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function useNoteExport({ setMessage }: UseNoteExportOptions) {
  const [preview, setPreview] = useState<NoteExportSnapshot | null>(null);
  const [exportingNoteId, setExportingNoteId] = useState<string | null>(null);
  const pendingPdfFilenameRef = useRef<string | null>(null);

  useEffect(() => {
    if (!preview || !pendingPdfFilenameRef.current) return;
    const filename = pendingPdfFilenameRef.current;
    const frame = window.requestAnimationFrame(() => {
      const exportPdf = async () => {
        const previousTitle = document.title;
        document.title = filename.replace(/\.pdf$/i, "");
        try {
          if (window.folio?.savePdfExport) {
            const result = await window.folio.savePdfExport(filename);
            if (!result.canceled) setMessage(`Exported ${filename}`);
          } else {
            window.print();
            setMessage("Opened the print dialog for PDF export.");
          }
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not export PDF.",
          );
        } finally {
          document.title = previousTitle;
          pendingPdfFilenameRef.current = null;
          setPreview(null);
          setExportingNoteId(null);
        }
      };
      void exportPdf();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [preview, setMessage]);

  async function exportDocument(
    document: ViewerDocument,
    draft: string | undefined,
    format: NoteExportFormat,
  ) {
    const snapshot = noteExportSnapshot(document, draft);
    const filename = noteExportFilename(snapshot.title, format);
    setExportingNoteId(document.id);
    if (format === "pdf") {
      pendingPdfFilenameRef.current = filename;
      setPreview(snapshot);
      return;
    }
    try {
      if (window.folio?.saveMarkdownExport) {
        const result = await window.folio.saveMarkdownExport(
          filename,
          snapshot.content,
        );
        if (!result.canceled) setMessage(`Exported ${filename}`);
      } else {
        downloadMarkdown(filename, snapshot.content);
        setMessage(`Downloaded ${filename}`);
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not export Markdown.",
      );
    } finally {
      setExportingNoteId(null);
    }
  }

  return { preview, exportingNoteId, exportDocument };
}

