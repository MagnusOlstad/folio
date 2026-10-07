import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { RenderedMarkdown } from "../../src/features/workspace/components/RenderedMarkdown.tsx";

const note: ViewerDocument = {
  id: "/notes/current.md",
  title: "Current note",
  type: "Note",
  description: "",
  tags: [],
  createdAt: "2026-09-06T08:00:00.000Z",
  content: "",
  deletable: true,
  movable: true,
  status: "stable",
  staleAfter: null,
  stale: false,
  filedBy: null,
  filedAt: null,
  links: [],
  backlinks: [],
  suggestions: [],
};
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const scrolled: HTMLElement[] = [];
const scrollIntoView = vi.fn(function (this: HTMLElement) {
  scrolled.push(this);
});

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});
beforeEach(() => {
  scrolled.length = 0;
  scrollIntoView.mockClear();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

function renderViewer(content: string, portal = false) {
  const onOpenDocument = vi.fn().mockResolvedValue(undefined);
  const onToggleTask = vi.fn().mockResolvedValue(undefined);
  const view = (document: ViewerDocument, saving = false) => (
    <div className="document-view">
      {portal ? <div data-document-find-layer="" /> : null}
      <div data-document-scroll="">
        <RenderedMarkdown
          document={document}
          groupId="secondary"
          saving={saving}
          onOpenDocument={onOpenDocument}
          onToggleTask={onToggleTask}
        />
      </div>
    </div>
  );
  const result = render(view({ ...note, content }));
  const viewer = result.container.querySelector<HTMLElement>("[data-readonly-markdown]")!;
  function openFind() {
    act(() => viewer.dispatchEvent(new CustomEvent("folio-find")));
    return screen.getByRole("textbox", { name: "Find in current note" });
  }
  function search(query: string) {
    fireEvent.change(openFind(), { target: { value: query } });
  }
  return {
    ...result,
    viewer,
    openFind,
    search,
    onOpenDocument,
    onToggleTask,
    update: (content: string, saving = false) => result.rerender(view({ ...note, content }, saving)),
    matches: () => Array.from(viewer.querySelectorAll("mark.readonly-search-match")),
  };
}

describe("rendered markdown search", () => {
  it("removes highlights on close and safely restores the retained query", () => {
    const view = renderViewer("First match and MATCH again.");
    view.search("match");
    expect(view.matches().map((match) => match.textContent)).toEqual(["match", "MATCH"]);
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(view.matches()).toHaveLength(0);
    expect(view.viewer).toHaveTextContent("First match and MATCH again.");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    const reopenedInput = view.openFind() as HTMLInputElement;
    expect(reopenedInput).toHaveValue("match");
    expect(reopenedInput.selectionStart).toBe(0);
    expect(reopenedInput.selectionEnd).toBe(5);
    expect(view.matches()).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(view.matches()).toHaveLength(0);
  });

  it("excludes the inline find controls and does not keep stale results for an empty query", () => {
    const view = renderViewer("Note content.");
    view.search("Next");
    expect(view.matches()).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toHaveTextContent("Next");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "note" } });
    expect(view.matches()).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(view.matches()).toHaveLength(0);
    expect(screen.queryByText("No matches")).not.toBeInTheDocument();
    expect(screen.queryByText("1 of 1")).not.toBeInTheDocument();
  });

  it("wraps next and previous matches and scrolls the active result", () => {
    const view = renderViewer("word word word");
    view.search("word");
    expect(view.matches()[0]).toHaveClass("active");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    expect(view.matches()[2]).toHaveClass("active");
    expect(scrolled.at(-1)).toBe(view.matches()[2]);
    expect(scrolled.at(-1)?.isConnected).toBe(true);

    fireEvent.submit(screen.getByRole("button", { name: "Next" }).closest("form")!);
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(scrolled.at(-1)).toBe(view.matches()[0]);
    expect(scrolled.at(-1)?.isConnected).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    expect(view.matches().filter((match) => match.classList.contains("active"))).toHaveLength(1);
    expect(scrolled.at(-1)).toBe(view.matches()[2]);
    expect(scrolled.at(-1)?.isConnected).toBe(true);
  });

  it("updates highlights with document changes while preserving task and link behavior", () => {
    const initial = "[Match other](other.md)\n\n- [ ] Match task";
    const view = renderViewer(initial);
    view.search("match");
    expect(view.matches()).toHaveLength(2);
    fireEvent.click(screen.getByRole("link", { name: "Match other" }));
    expect(view.onOpenDocument).toHaveBeenCalledWith("/notes/other.md", "file", "secondary");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(view.onToggleTask).toHaveBeenCalledWith({ ...note, content: initial }, 3, true);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    view.update("[Match changed](other.md)\n\n- [x] Completed task");
    expect(view.matches()).toHaveLength(1);
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(view.matches()[0]).toHaveClass("active");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("link", { name: "Match changed" })).toHaveAttribute("href", expect.stringContaining("other.md"));
    expect(screen.getByRole("checkbox").closest("li")).toHaveAttribute("data-source-line", "3");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    view.update("Changed again.");
    expect(view.viewer).toHaveTextContent("Changed again.");
    expect(view.matches()).toHaveLength(0);
  });

  it("keeps navigation attached to current marks after saving state rerenders the document", () => {
    const content = "- [ ] word task\n\nword paragraph";
    const view = renderViewer(content);
    view.search("word");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();

    view.update(content, true);
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(view.matches()[1]).toHaveClass("active");
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(view.matches()[0]).toHaveClass("active");
    expect(scrolled.at(-1)).toBe(view.matches()[0]);
    expect(scrolled.at(-1)?.isConnected).toBe(true);
  });

  it("keeps original Unicode text and offsets after case folding expands a character", () => {
    const view = renderViewer("İ target and 𐐀 TARGET.");
    view.search("target");
    expect(view.matches().map((match) => match.textContent)).toEqual(["target", "TARGET"]);
    expect(view.viewer.querySelector("p")).toHaveTextContent("İ target and 𐐀 TARGET.");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "i" } });
    expect(view.matches().map((match) => match.textContent)).toEqual(["İ"]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "𐐨" } });
    expect(view.matches().map((match) => match.textContent)).toEqual(["𐐀"]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(view.viewer.querySelector("p")).toHaveTextContent("İ target and 𐐀 TARGET.");
  });

  it("searches literal query punctuation, code, and formatted text", () => {
    const view = renderViewer("**a.b** `a.b`\n\n```\na.b\n```");
    view.search("a.b");
    expect(view.matches()).toHaveLength(3);
    expect(view.viewer.querySelector("strong mark")).toHaveTextContent("a.b");
    expect(view.viewer.querySelector("pre code mark")).toHaveTextContent("a.b");
  });

  it("focuses the portaled panel without changing the document scroll position", () => {
    const view = renderViewer("Find this.", true);
    const scroll = view.viewer.closest<HTMLElement>("[data-document-scroll]")!;
    scroll.scrollTop = 120;
    const input = view.openFind();
    expect(input).toHaveFocus();
    expect(scroll.scrollTop).toBe(120);
    expect(view.viewer.querySelector("form")).toBeNull();
    view.search("find");
    expect(view.matches()).toHaveLength(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });
});
