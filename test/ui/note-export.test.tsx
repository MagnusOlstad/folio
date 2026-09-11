import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { NoteExportMenu } from "../../src/features/workspace/components/NoteExportMenu.tsx";
import { NoteExportPreview } from "../../src/features/workspace/components/NoteExportPreview.tsx";
import { useNoteExport } from "../../src/features/workspace/hooks/useNoteExport.ts";
import {
  noteExportFilename,
  noteExportSnapshot,
} from "../../src/features/workspace/model/note-export.ts";

const document: ViewerDocument = {
  id: "/notes/export.md",
  title: "Quarterly: plan / review",
  type: "Note",
  description: "A useful summary",
  tags: [],
  createdAt: "2026-09-11T08:00:00.000Z",
  content: "Stored content",
  deletable: true,
  movable: true,
  status: "stable",
  staleAfter: null,
  stale: false,
  filedBy: "human:test",
  filedAt: "2026-09-11T08:00:00.000Z",
  links: [],
  backlinks: [],
  suggestions: [],
};

afterEach(() => {
  delete window.folio;
  vi.restoreAllMocks();
});

describe("note export model", () => {
  it("uses the current draft and produces safe title-based filenames", () => {
    expect(noteExportSnapshot(document, "Unsaved **Markdown**").content).toBe(
      "Unsaved **Markdown**",
    );
    expect(noteExportFilename(document.title, "markdown")).toBe(
      "Quarterly- plan - review.md",
    );
    expect(noteExportFilename("CON", "pdf")).toBe("CON-note.pdf");
    expect(noteExportFilename("...", "pdf")).toBe("Untitled.pdf");
    expect(
      noteExportSnapshot(
        { ...document, id: "untitled:export", title: "Untitled" },
        "# Draft heading\n\nBody",
      ).title,
    ).toBe("Draft heading");
  });
});

describe("NoteExportMenu", () => {
  it("keeps formats behind one accessible control and closes on Escape", () => {
    const onExport = vi.fn();
    render(
      <NoteExportMenu
        title="Export note"
        exporting={false}
        onExport={onExport}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Export" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Export Export note" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Markdown" }));
    expect(onExport).toHaveBeenCalledWith("markdown");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("note export behavior", () => {
  it("downloads the exact Markdown snapshot in the browser", async () => {
    const setMessage = vi.fn();
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:note");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { result } = renderHook(() => useNoteExport({ setMessage }));

    await act(() =>
      result.current.exportDocument(document, "Unsaved **Markdown**", "markdown"),
    );

    const blob = createObjectURL.mock.calls[0][0];
    expect(await blob.text()).toBe("Unsaved **Markdown**");
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:note");
    expect(setMessage).toHaveBeenCalledWith(
      "Downloaded Quarterly- plan - review.md",
    );
  });

  it("prints a mounted preview in the browser and restores the app title", async () => {
    const setMessage = vi.fn();
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const previousTitle = window.document.title;
    const { result } = renderHook(() => useNoteExport({ setMessage }));

    act(() => {
      void result.current.exportDocument(document, undefined, "pdf");
    });

    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(window.document.title).toBe(previousTitle);
    expect(result.current.preview).toBeNull();
    expect(setMessage).toHaveBeenCalledWith(
      "Opened the print dialog for PDF export.",
    );
  });

  it("uses the Electron bridge and treats cancellation silently", async () => {
    const setMessage = vi.fn();
    const saveMarkdownExport = vi.fn().mockResolvedValue({ canceled: true });
    window.folio = { saveMarkdownExport };
    const { result } = renderHook(() => useNoteExport({ setMessage }));

    await act(() =>
      result.current.exportDocument(document, "Current", "markdown"),
    );

    expect(saveMarkdownExport).toHaveBeenCalledWith(
      "Quarterly- plan - review.md",
      "Current",
    );
    expect(setMessage).not.toHaveBeenCalled();
  });

  it("routes PDF generation through Electron after preparing the preview", async () => {
    const setMessage = vi.fn();
    const savePdfExport = vi.fn().mockResolvedValue({ canceled: false });
    window.folio = { savePdfExport };
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { result } = renderHook(() => useNoteExport({ setMessage }));

    act(() => {
      void result.current.exportDocument(document, "Current", "pdf");
    });

    await waitFor(() =>
      expect(savePdfExport).toHaveBeenCalledWith(
        "Quarterly- plan - review.pdf",
      ),
    );
    expect(setMessage).toHaveBeenCalledWith(
      "Exported Quarterly- plan - review.pdf",
    );
  });
});

describe("NoteExportPreview", () => {
  it("renders filed note metadata and GFM content for printing", () => {
    render(
      <NoteExportPreview
        snapshot={{
          id: document.id,
          title: document.title,
          description: document.description,
          content: "## Tasks\n\n- [x] Done\n\n| A | B |\n| - | - |\n| 1 | 2 |",
          draft: false,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: document.title })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
