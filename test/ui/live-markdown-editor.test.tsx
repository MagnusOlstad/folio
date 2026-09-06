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
    fireEvent.focus(editor);
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

  it("continues task lists with Enter", () => {
    expect(continueLiveMarkdownList("- [x] done", 10, 10)).toEqual({
      value: "- [x] done\n- [ ] ",
      caret: 17,
    });
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
