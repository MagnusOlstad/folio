import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { continueLiveMarkdownList } from "../../src/features/workspace/model/live-markdown.ts";

describe("LiveMarkdownEditor", () => {
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
    expect(document.querySelector(".cm-live-markdown-marker")).toBeTruthy();
    fireEvent.focus(editor);
    expect(document.querySelector(".cm-live-markdown-heading")).toBeTruthy();
    expect(document.querySelector(".cm-live-markdown-marker")).toBeNull();
    fireEvent.blur(editor);
    expect(document.querySelector(".cm-live-markdown-marker")).toBeTruthy();
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
    expect(lines[0].style.getPropertyValue("--live-markdown-list-offset")).toBe(
      "22px",
    );
    expect(lines[1].style.getPropertyValue("--live-markdown-list-offset")).toBe(
      "42px",
    );
    expect(
      lines[1].querySelector(".cm-live-markdown-marker")?.textContent,
    ).toBe("  - ");

    fireEvent.focus(screen.getByLabelText("Edit nested list"));

    const revealedPrefix = lines[0].querySelector(
      ".cm-live-markdown-list-source",
    );
    expect(revealedPrefix?.textContent).toBe("- ");
    expect(lines[0].style.getPropertyValue("--live-markdown-list-offset")).toBe(
      "22px",
    );
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
    fireEvent.click(screen.getByLabelText("Toggle task on line 1"));

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
});
