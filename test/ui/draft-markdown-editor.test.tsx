import { fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { DraftMarkdownEditor } from "../../src/features/workspace/components/DraftMarkdownEditor.tsx";

describe("DraftMarkdownEditor", () => {
  it("forwards focus requests to the live editor", () => {
    const frames: FrameRequestCallback[] = [];
    vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const onFocusRequestConsumed = vi.fn();

    render(
      <DraftMarkdownEditor
        value="Draft note"
        onChange={vi.fn()}
        onFile={vi.fn()}
        focusRequestId={7}
        onFocusRequestConsumed={onFocusRequestConsumed}
        ariaLabel="Write a new note"
      />,
    );

    const view = EditorView.findFromDOM(screen.getByLabelText("Write a new note"));
    act(() => {
      frames.forEach((frame) => frame(0));
    });

    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(view.hasFocus).toBe(true);
    expect(onFocusRequestConsumed).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("keeps the steering placeholder while mounting an accessible live editor", () => {
    render(
      <DraftMarkdownEditor
        value=""
        onChange={vi.fn()}
        onFile={vi.fn()}
        ariaLabel="Write a new note"
      />,
    );

    expect(screen.getByLabelText("Write a new note")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    expect(
      document.querySelector(".draft-steering-placeholder"),
    ).toHaveTextContent(/Optional: steer the title or path here/);
    expect(document.querySelector(".draft-steering-band")).toBeTruthy();
  });

  it("files with Cmd/Ctrl+Enter", () => {
    const onFile = vi.fn();
    render(
      <DraftMarkdownEditor
        value="# Draft"
        onChange={vi.fn()}
        onFile={onFile}
        ariaLabel="Write a new note"
      />,
    );
    const editor = screen.getByLabelText("Write a new note");

    fireEvent.focus(editor);
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    expect(onFile).toHaveBeenCalledOnce();
  });

  it("keeps rendered draft task controls interactive", () => {
    const onToggleTask = vi.fn();
    render(
      <DraftMarkdownEditor
        value="- [ ] Draft task"
        onChange={vi.fn()}
        onFile={vi.fn()}
        onToggleTask={onToggleTask}
        ariaLabel="Write a new note"
      />,
    );

    fireEvent.click(screen.getByLabelText("Toggle task on line 1"));

    expect(onToggleTask).toHaveBeenCalledWith(1, true);
  });
});
