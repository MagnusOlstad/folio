import { fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { continueLiveMarkdownList } from "../../src/features/workspace/model/live-markdown.ts";

describe("LiveMarkdownEditor", () => {
  it("focuses and collapses the caret at the end for a focus request", () => {
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const onFocusRequestConsumed = vi.fn();

    render(
      <LiveMarkdownEditor
        value="Some note"
        onChange={vi.fn()}
        focusRequestId={1}
        onFocusRequestConsumed={onFocusRequestConsumed}
        ariaLabel="Focus note"
      />,
    );

    const view = EditorView.findFromDOM(screen.getByLabelText("Focus note"));
    expect(view.state.selection.main.head).toBe(0);
    act(() => frames.at(-1)?.(0));

    expect(view.state.selection.main.from).toBe(view.state.doc.length);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
    expect(view.hasFocus).toBe(true);
    expect(onFocusRequestConsumed).toHaveBeenCalledOnce();
    requestAnimationFrame.mockRestore();
    vi.restoreAllMocks();
  });

  it("cancels a pending focus request when its request id changes", () => {
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      cancelAnimationFrame,
    );
    const onFocusRequestConsumed = vi.fn();
    const { rerender } = render(
      <LiveMarkdownEditor
        value="Some note"
        onChange={vi.fn()}
        focusRequestId={1}
        onFocusRequestConsumed={onFocusRequestConsumed}
        ariaLabel="Focus note"
      />,
    );

    rerender(
      <LiveMarkdownEditor
        value="Some note"
        onChange={vi.fn()}
        focusRequestId={2}
        onFocusRequestConsumed={onFocusRequestConsumed}
        ariaLabel="Focus note"
      />,
    );

    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    act(() => frames.at(-1)?.(0));
    expect(onFocusRequestConsumed).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("exposes an accessible continuously mounted CodeMirror editor", () => {
    render(
      <LiveMarkdownEditor
        value="# Heading\nPlain text"
        onChange={vi.fn()}
        ariaLabel="Edit readme"
      />,
    );

    const editor = screen.getByLabelText("Edit readme");
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(document.querySelector("[data-live-markdown-editor]")).toBeTruthy();
    expect(document.querySelector("[data-live-markdown-scroll]")).toBeTruthy();

    expect(document.querySelector(".cm-live-markdown-heading")).toBeTruthy();
    expect(editor).not.toHaveTextContent("# Heading");
    fireEvent.focus(editor);
    expect(document.querySelector(".cm-live-markdown-heading")).toBeTruthy();
    expect(editor).toHaveTextContent("# Heading");
    fireEvent.blur(editor);
    expect(editor).not.toHaveTextContent("# Heading");
  });

  it("uses the CodeMirror GFM syntax tree for nested strikethrough", () => {
    render(
      <LiveMarkdownEditor
        value={"~~removed **strong**~~\n\\~~literal~~"}
        onChange={vi.fn()}
        ariaLabel="Edit formatting"
      />,
    );

    const strike = document.querySelector(".cm-live-markdown-strike");
    expect(strike).toHaveTextContent("removed strong");
    expect(strike?.querySelector(".cm-live-markdown-strong")).toHaveTextContent(
      "strong",
    );
    expect(document.querySelectorAll(".cm-live-markdown-strike")).toHaveLength(1);
  });

  it("recognizes ATX heading levels without treating hyphen underlines as headings", () => {
    render(
      <LiveMarkdownEditor
        value={"# First\n## Second\nThird\n---"}
        onChange={vi.fn()}
        ariaLabel="Edit headings"
      />,
    );

    expect(screen.getByRole("heading", { name: "First", level: 1 })).toHaveClass(
      "cm-live-markdown-heading-1",
    );
    expect(screen.getByRole("heading", { name: "Second", level: 2 })).toHaveClass(
      "cm-live-markdown-heading-2",
    );
    expect(screen.queryByRole("heading", { name: "Third" })).toBeNull();
    expect(document.querySelector(".cm-live-markdown-horizontal-rule")).toBeTruthy();
  });

  it("does not resize the preceding sentence when a single dash is typed", () => {
    render(
      <LiveMarkdownEditor
        value={"A sentence\n-"}
        onChange={vi.fn()}
        ariaLabel="Edit note"
      />,
    );

    expect(screen.queryByRole("heading", { name: "A sentence" })).toBeNull();
    expect(document.querySelector(".cm-live-markdown-heading")).toBeNull();
  });

  it("uses the existing folio-format event contract", () => {
    const onChange = vi.fn();
    render(
      <LiveMarkdownEditor
        value="hello"
        onChange={onChange}
        ariaLabel="Edit note"
      />,
    );
    const editor = screen.getByLabelText("Edit note");
    fireEvent.focus(editor);
    editor.dispatchEvent(
      new CustomEvent("folio-format", { detail: "bold", cancelable: true }),
    );

    expect(onChange).toHaveBeenCalledWith("****hello");
  });

  it("opens a compact Find panel with the current and total match count", () => {
    render(
      <LiveMarkdownEditor
        value="first match, second match"
        onChange={vi.fn()}
        ariaLabel="Edit note"
      />,
    );

    document
      .querySelector("[data-live-markdown-editor]")
      ?.dispatchEvent(new CustomEvent("folio-find"));
    const input = screen.getByRole("searchbox", { name: "Find in note" });
    fireEvent.input(input, { target: { value: "match" } });

    expect(screen.getByText("2 results")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("1 of 2 results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Find" })).toHaveTextContent("×");
  });

  it("continues task lists with Enter", () => {
    expect(continueLiveMarkdownList("- [x] done", 10, 10)).toEqual({
      value: "- [x] done\n- [ ] ",
      caret: 17,
    });
  });

  it("reveals only the task syntax under the cursor", () => {
    render(
      <LiveMarkdownEditor
        value="- [ ] Next"
        onChange={vi.fn()}
        ariaLabel="Edit tasks"
      />,
    );

    const editor = screen.getByLabelText("Edit tasks");
    fireEvent.focus(editor);
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    fireEvent.keyDown(editor, { key: "ArrowRight" });

    expect(screen.queryByLabelText("Toggle task on line 1")).toBeNull();
    expect(editor).toHaveTextContent("[ ]");
  });

  it("presents fenced code and nested list bullets when inactive", () => {
    render(
      <LiveMarkdownEditor
        value={"```ts\nconst answer = 42;\n```\n- parent\n  - child"}
        onChange={vi.fn()}
        ariaLabel="Edit code and lists"
      />,
    );

    expect(document.querySelectorAll(".cm-live-markdown-code-block")).toHaveLength(3);
    expect(
      document.querySelectorAll(".cm-live-markdown-code-fence-hidden"),
    ).toHaveLength(2);
    expect(document.querySelector(".cm-live-markdown-list-nested")).toBeTruthy();
  });

  it("keeps list content in the same gutter when source markers are revealed", () => {
    render(
      <LiveMarkdownEditor
        value={"- parent\n  - child"}
        onChange={vi.fn()}
        ariaLabel="Edit nested list"
      />,
    );

    const lines = document.querySelectorAll<HTMLElement>(".cm-live-markdown-list");
    expect(lines).toHaveLength(2);
    expect(
      lines[1].querySelector(".cm-live-markdown-list-marker")?.textContent,
    ).toBe("◦");
    expect(lines[1].textContent?.startsWith("  ◦child")).toBe(true);

    fireEvent.focus(screen.getByLabelText("Edit nested list"));

    const revealedPrefix = lines[0].querySelector(
      ".cm-live-markdown-list-source",
    );
    expect(revealedPrefix?.textContent).toBe("- ");
  });

  it("shows multi-digit markers intact and nested ordered markers as letters", () => {
    render(
      <LiveMarkdownEditor
        value={"10. tenth\n  1. nested\n  2. another"}
        onChange={vi.fn()}
        ariaLabel="Edit ordered list"
      />,
    );

    const markers = document.querySelectorAll(".cm-live-markdown-list-marker");
    expect([...markers].map((marker) => marker.textContent)).toEqual([
      "10.",
      "a.",
      "b.",
    ]);
  });

  it("renumbers ordered items after a deletion and preserves the caret", () => {
    const onChange = vi.fn();
    render(
      <LiveMarkdownEditor
        value={"1. first\n2. second\n3. third"}
        onChange={onChange}
        ariaLabel="Edit numbered list"
      />,
    );
    const view = EditorView.findFromDOM(screen.getByLabelText("Edit numbered list"));

    act(() => {
      view.dispatch({
        changes: { from: 9, to: 19 },
        selection: { anchor: 9 },
      });
    });

    expect(view.state.doc.toString()).toBe("1. first\n2. third");
    expect(view.state.selection.main.head).toBe(9);
    expect(onChange).toHaveBeenLastCalledWith("1. first\n2. third");
  });

  it("uses Shift+Enter for a continuation line inside an ordered item", () => {
    const onChange = vi.fn();
    render(
      <LiveMarkdownEditor
        value="10. tenth"
        onChange={onChange}
        ariaLabel="Edit list continuation"
      />,
    );
    const editor = screen.getByLabelText("Edit list continuation");
    const view = EditorView.findFromDOM(editor);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));

    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    expect(view.state.doc.toString()).toBe("10. tenth\n    ");
    expect(view.state.selection.main.head).toBe(14);
    expect(onChange).toHaveBeenLastCalledWith("10. tenth\n    ");
  });

  it("opens bare web URLs only through modifier-click without hiding their text", () => {
    const onOpenLink = vi.fn();
    const value =
      "Bare https://example.com/docs and [Named](https://example.com/named) " +
      "and `https://example.com/code` and test@example.com";
    render(
      <LiveMarkdownEditor
        value={value}
        onChange={vi.fn()}
        onOpenLink={onOpenLink}
        ariaLabel="Edit links"
      />,
    );

    const editor = screen.getByLabelText("Edit links");
    const view = EditorView.findFromDOM(editor);
    expect(document.querySelectorAll(".cm-live-markdown-link")).toHaveLength(2);
    expect(editor).toHaveTextContent("https://example.com/docs");
    vi.spyOn(view, "posAtCoords").mockReturnValue(10);

    fireEvent.mouseDown(editor, { clientX: 0, clientY: 0 });
    expect(onOpenLink).not.toHaveBeenCalled();
    fireEvent.mouseDown(editor, { clientX: 0, clientY: 0, metaKey: true });

    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/docs");

    vi.mocked(view.posAtCoords).mockReturnValue(value.indexOf("Named") + 1);
    fireEvent.mouseDown(editor, { clientX: 0, clientY: 0, ctrlKey: true });

    expect(onOpenLink).toHaveBeenLastCalledWith("https://example.com/named");
  it("continues a bullet in a loose list without inserting an extra blank line", () => {
    const onChange = vi.fn();
    render(
      <LiveMarkdownEditor
        value={"- first\n\n- second"}
        onChange={onChange}
        ariaLabel="Edit loose list"
      />,
    );
    const editor = screen.getByLabelText("Edit loose list");
    const view = EditorView.findFromDOM(editor);
    act(() => view.dispatch({ selection: { anchor: 7 } }));

    fireEvent.keyDown(editor, { key: "Enter" });

    expect(view.state.doc.toString()).toBe("- first\n- \n\n- second");
    expect(view.state.selection.main.head).toBe(10);
    expect(onChange).toHaveBeenLastCalledWith("- first\n- \n\n- second");
  });

  it("finishes the presentation of an unclosed fenced code block", () => {
    render(
      <LiveMarkdownEditor
        value={"```ts\nconst answer = 42;"}
        onChange={vi.fn()}
        ariaLabel="Edit unclosed code"
      />,
    );

    expect(document.querySelector(".cm-live-markdown-code-block-last")).toHaveTextContent(
      "const answer = 42;",
    );
  });

  it("keeps task controls interactive on inactive lines", () => {
    const onToggleTask = vi.fn();
    render(
      <LiveMarkdownEditor
        value="- [ ] Next\nFirst line"
        onChange={vi.fn()}
        onToggleTask={onToggleTask}
        ariaLabel="Edit tasks"
      />,
    );
    const task = screen.getByLabelText("Toggle task on line 1");
    expect(task.closest(".cm-line")).not.toHaveTextContent("•");
    fireEvent.mouseDown(task);
    fireEvent.click(task);

    expect(onToggleTask).toHaveBeenCalledWith(1, true);
  });

  it("accepts external controlled value changes without replacing its root", () => {
    const { rerender } = render(
      <LiveMarkdownEditor value="First" onChange={vi.fn()} ariaLabel="Edit note" />,
    );
    const root = document.querySelector("[data-live-markdown-editor]");
    rerender(
      <LiveMarkdownEditor value="Second" onChange={vi.fn()} ariaLabel="Edit note" />,
    );

    expect(document.querySelector("[data-live-markdown-editor]")).toBe(root);
    expect(screen.getByLabelText("Edit note").textContent).toContain("Second");
  });

  it("does not apply stale controlled echoes over a newer local edit", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <LiveMarkdownEditor value="First" onChange={onChange} ariaLabel="Edit note" />,
    );
    const editor = screen.getByLabelText("Edit note");
    const view = EditorView.findFromDOM(editor);

    act(() => {
      view.dispatch({ changes: { from: 5, insert: "\n" }, selection: { anchor: 6 } });
      view.dispatch({ changes: { from: 6, insert: "\n" }, selection: { anchor: 7 } });
    });
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      "First\n",
      "First\n\n",
    ]);

    rerender(
      <LiveMarkdownEditor
        value={"First\n"}
        onChange={onChange}
        ariaLabel="Edit note"
      />,
    );

    expect(view.state.doc.toString()).toBe("First\n\n");
    expect(view.state.selection.main.head).toBe(7);

    rerender(
      <LiveMarkdownEditor
        value={"First\n\n"}
        onChange={onChange}
        ariaLabel="Edit note"
      />,
    );
    rerender(
      <LiveMarkdownEditor
        value="External"
        onChange={onChange}
        ariaLabel="Edit note"
      />,
    );

    expect(view.state.doc.toString()).toBe("External");
  });
});
