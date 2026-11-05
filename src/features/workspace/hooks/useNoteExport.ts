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

const IMAGE_WAIT_MS = 10_000;

/** Resolves once every preview image has loaded or failed, fonts are ready, or the timeout hits. */
export function waitForExportAssets(timeoutMs = IMAGE_WAIT_MS) {
  const images = Array.from(
    document.querySelectorAll<HTMLImageElement>(".note-export-preview img"),
  );
  const loads = images.map(
    (image) =>
      new Promise<void>((resolve) => {
        if (image.complete) return resolve();
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      }),
  );
  const fonts = document.fonts?.ready ?? Promise.resolve();
  let timer: number | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    Promise.all([...loads, fonts]).then(() => undefined),
    timeout,
  ]).finally(() => window.clearTimeout(timer));
}

export function useNoteExport({ setMessage }: UseNoteExportOptions) {
  const [preview, setPreview] = useState<NoteExportSnapshot | null>(null);
  const [exportingNoteId, setExportingNoteId] = useState<string | null>(null);
  const pendingPdfFilenameRef = useRef<string | null>(null);
  const pendingNoticeRef = useRef("");

  useEffect(() => {
    if (!preview || !pendingPdfFilenameRef.current) return;
    const filename = pendingPdfFilenameRef.current;
    const frame = window.requestAnimationFrame(() => {
      const exportPdf = async () => {
        const previousTitle = document.title;
        document.title = filename.replace(/\.pdf$/i, "");
        try {
          await waitForExportAssets();
          if (window.folio?.savePdfExport) {
            const result = await window.folio.savePdfExport(filename);
            if (!result.canceled) setMessage(`Exported ${filename}${pendingNoticeRef.current}`);
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

  async function exportSnapshot(
    snapshot: NoteExportSnapshot,
    format: NoteExportFormat,
    filename: string,
    noteId: string,
    notice = "",
  ) {
    setExportingNoteId(noteId);
    pendingNoticeRef.current = notice;
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
        if (!result.canceled) setMessage(`Exported ${filename}${notice}`);
      } else {
        downloadMarkdown(filename, snapshot.content);
        setMessage(`Downloaded ${filename}${notice}`);
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not export Markdown.",
      );
    } finally {
      setExportingNoteId(null);
    }
  }

  async function exportDocument(
    document: ViewerDocument,
    draft: string | undefined,
    format: NoteExportFormat,
  ) {
    const snapshot = noteExportSnapshot(document, draft);
    await exportSnapshot(snapshot, format, noteExportFilename(snapshot.title, format), document.id);
  }

  return { preview, exportingNoteId, exportDocument, exportSnapshot };
}

