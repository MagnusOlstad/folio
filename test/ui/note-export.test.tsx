import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { NoteMoreMenu } from "../../src/features/workspace/components/NoteMoreMenu.tsx";
import { NoteExportPreview } from "../../src/features/workspace/components/NoteExportPreview.tsx";
import { useNoteExport, waitForExportAssets } from "../../src/features/workspace/hooks/useNoteExport.ts";
import { remarkPreserveBlankLines } from "../../src/features/workspace/model/export-spacing.ts";
import {
  noteExportFilename,
  noteExportSnapshot,
  withoutLeadingTitleHeading,
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
        "\n# Draft heading\n\nBody",
      ).title,
    ).toBe("Draft heading");
  });

  it("excludes persisted filing guidance when exporting an untouched recovered draft", () => {
    const recoveredDraft = {
      ...document,
      id: "untitled:recovered",
      title: "Untitled",
      content: "File under /Work\n# Project notes\n\nKeep this body",
    };
    const snapshot = noteExportSnapshot(recoveredDraft, undefined);
    expect(snapshot.title).toBe("Project notes");
    expect(snapshot.content).toBe("# Project notes\n\nKeep this body");
  });
});

describe("withoutLeadingTitleHeading", () => {
  it("removes a matching first level-1 heading", () => {
    expect(withoutLeadingTitleHeading("\n\n# My Note\n\nBody", "My Note")).toBe("\nBody");
    expect(withoutLeadingTitleHeading("# my note #\nBody", "My Note")).toBe("Body");
  });

  it("matches through inline markdown", () => {
    expect(
      withoutLeadingTitleHeading("# **My** `Note` [link](http://x)\nBody", "My Note link"),
    ).toBe("Body");
  });

  it("keeps non-matching, non-first, and non-level-1 headings", () => {
    expect(withoutLeadingTitleHeading("# Other\nBody", "My Note")).toBe("# Other\nBody");
    expect(withoutLeadingTitleHeading("Intro\n# My Note", "My Note")).toBe("Intro\n# My Note");
    expect(withoutLeadingTitleHeading("## My Note\nBody", "My Note")).toBe("## My Note\nBody");
  });

  it("does not alter the Markdown export content", () => {
    const content = "# Quarterly: plan / review\n\nBody";
    expect(noteExportSnapshot({ ...document, content }, undefined).content).toBe(content);
  });

  it("renders the title once in the preview", () => {
    render(
      <NoteExportPreview
        snapshot={{ id: document.id, title: "My Note", description: "", content: "# My Note\n\nBody", draft: false }}
      />,
    );
    expect(screen.getAllByRole("heading", { name: "My Note" })).toHaveLength(1);
  });
});

describe("NoteMoreMenu", () => {
  const renderMenu = (props: Partial<React.ComponentProps<typeof NoteMoreMenu>> = {}) => {
    const onExport = vi.fn();
    const onRefile = vi.fn();
    render(
      <NoteMoreMenu
        title="Export note"
        exporting={false}
        onExport={onExport}
        refile={{ onRefile, disabled: false }}
        {...props}
      />,
    );
    return { onExport, onRefile, trigger: screen.getByRole("button", { name: "More actions" }) };
  };

  it("keeps refile, export formats and translate behind one accessible control", () => {
    const { onExport, trigger } = renderMenu({
      translate: { document, available: true, onDeliver: vi.fn(async () => {}) },
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveTextContent("More");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "More actions for Export note" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Refile…", "Markdown", "PDF", "Translate…"]);
    expect(within(within(menu).getByRole("group", { name: "Export" })).getAllByRole("menuitem")).toHaveLength(2);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "Markdown" }));
    expect(onExport).toHaveBeenCalledWith("markdown");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens upward and anchors to the trigger's right edge", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toHaveClass("note-more-options");
    expect(screen.getByRole("menu").parentElement).toHaveClass("note-more-menu");
  });

  it("omits Refile where it is not offered and disables it with a reason in translated views", () => {
    const first = renderMenu({ refile: undefined });
    fireEvent.click(first.trigger);
    expect(screen.queryByRole("menuitem", { name: "Refile…" })).toBeNull();
    cleanup();
    renderMenu({ refile: { onRefile: vi.fn(), disabled: true, reason: "Switch back to the original to refile" } });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const item = screen.getByRole("menuitem", { name: "Refile…" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "Switch back to the original to refile");
  });

  it("runs Refile from the menu", () => {
    const { onRefile, trigger } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Refile…" }));
    expect(onRefile).toHaveBeenCalled();
  });

  it("navigates with the keyboard, skipping disabled items, and Escape returns focus", () => {
    const { trigger } = renderMenu({ refile: { onRefile: vi.fn(), disabled: true } });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    const markdown = screen.getByRole("menuitem", { name: "Markdown" });
    const pdf = screen.getByRole("menuitem", { name: "PDF" });
    markdown.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(pdf).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(markdown).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(pdf).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(markdown).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows Exporting… and disables the trigger while exporting", () => {
    const { trigger } = renderMenu({ exporting: true });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("Exporting…");
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
    // print() runs before the hook's finally cleanup; wait for it to settle.
    await waitFor(() => expect(result.current.preview).toBeNull());
    expect(window.document.title).toBe(previousTitle);
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

describe("remarkPreserveBlankLines", () => {
  const block = (type: string, start: number, end: number) => ({
    type,
    position: { start: { line: start }, end: { line: end } },
  });
  const styleOf = (node: { data?: { hProperties?: Record<string, unknown> } }) =>
    node.data?.hProperties?.style;

  it("adds no space for a single blank line and scales for more", () => {
    const tree = {
      children: [
        block("paragraph", 1, 1),
        block("paragraph", 3, 3),
        block("paragraph", 7, 7),
      ],
    };
    remarkPreserveBlankLines()(tree);
    expect(styleOf(tree.children[1])).toBeUndefined();
    expect(styleOf(tree.children[2])).toBe("padding-top:2.90em");
  });

  it("is a no-op without positions", () => {
    const tree = { children: [{ type: "paragraph" }, { type: "paragraph" }] };
    remarkPreserveBlankLines()(tree);
    expect(styleOf(tree.children[1])).toBeUndefined();
  });

  it("renders the extra space on images and paragraphs in the preview", () => {
    const { container } = render(
      <NoteExportPreview
        snapshot={{
          id: document.id,
          title: document.title,
          description: "",
          content: "![a](x.png)\n\n\n\n![b](y.png)\n\ntext\n\n\n\nmore",
          draft: true,
        }}
      />,
    );
    const paragraphs = Array.from(container.querySelectorAll("p"));
    expect(paragraphs[0]).not.toHaveAttribute("style");
    expect(paragraphs[1].getAttribute("style")).toContain("padding-top: 2.9em");
    expect(paragraphs[2]).not.toHaveAttribute("style");
    expect(paragraphs[3].getAttribute("style")).toContain("padding-top: 2.9em");
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

  it("resolves asset images, applies the width suffix and strips it from alt", () => {
    render(
      <NoteExportPreview
        snapshot={{
          id: document.id,
          title: document.title,
          description: "",
          content: "![Chart|300](/assets/chart.png)\n\n![Plain](https://example.com/a.png)",
          draft: false,
        }}
      />,
    );

    const chart = screen.getByAltText("Chart");
    expect(chart.getAttribute("src")).toContain("/api/assets?path=%2Fassets%2Fchart.png");
    expect(chart).toHaveAttribute("width", "300");
    expect(chart).toHaveAttribute("loading", "eager");
    const plain = screen.getByAltText("Plain");
    expect(plain).toHaveAttribute("src", "https://example.com/a.png");
    expect(plain).not.toHaveAttribute("width");
  });
});

describe("waitForExportAssets", () => {
  it("waits for pending preview images to load or fail", async () => {
    const article = window.document.createElement("article");
    article.className = "note-export-preview";
    const loading = window.document.createElement("img");
    const failing = window.document.createElement("img");
    for (const image of [loading, failing])
      Object.defineProperty(image, "complete", { value: false });
    article.append(loading, failing);
    window.document.body.append(article);
    let done = false;
    const wait = waitForExportAssets(5000).then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(done).toBe(false);
    loading.dispatchEvent(new Event("load"));
    failing.dispatchEvent(new Event("error"));
    await wait;
    expect(done).toBe(true);
    article.remove();
  });
});
