import { fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { DraftMarkdownEditor } from "../../src/features/workspace/components/DraftMarkdownEditor.tsx";

describe("DraftMarkdownEditor", () => {
  it("focuses the live editor without moving its selection", () => {
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
        initialSelection={{ from: 2, to: 7 }}
      />,
    );

    const view = EditorView.findFromDOM(screen.getByLabelText("Write a new note"));
    act(() => {
      frames.forEach((frame) => frame(0));
    });

    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(7);
    expect(view.hasFocus).toBe(true);
    expect(onFocusRequestConsumed).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("shows optional filing guidance separately from the note placeholder", () => {
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
    expect(screen.getByRole("textbox", { name: "Filing guidance" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Filing guidance" })).toHaveAttribute(
      "placeholder",
      "Optional: title, folder, or filing context…",
    );
    expect(screen.queryByText("Optional", { exact: true })).toBeNull();
    expect(document.querySelector(".cm-placeholder")).toHaveTextContent("Write your note…");
    expect(document.querySelector(".draft-steering-band")).toBeNull();
  });

  it("explains filing guidance through a keyboard accessible tooltip", () => {
    render(
      <DraftMarkdownEditor
        value=""
        onChange={vi.fn()}
        onFile={vi.fn()}
        ariaLabel="Write a new note"
      />,
    );
    const trigger = screen.getByRole("button", { name: "About filing guidance" });
    const tooltip = screen.getByRole("tooltip");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent("existing folder names guide filing");
    expect(tooltip).toHaveTextContent("body remains unchanged");
    expect(tooltip).toHaveTextContent("path: /projects/atlas");
  });

  it("shows a path-directed draft as guidance and leaves the note body empty", () => {
    render(
      <DraftMarkdownEditor
        value={"path: /Research Area\n"}
        onChange={vi.fn()}
        onFile={vi.fn()}
        ariaLabel="Write a new note"
      />,
    );

    const view = EditorView.findFromDOM(screen.getByLabelText("Write a new note"));
    expect(view.state.doc.toString()).toBe("");
    expect(screen.getByRole("textbox", { name: "Filing guidance" })).toHaveValue("path: /Research Area");
  });

  it("updates guidance without changing the note body and keeps typed spaces", () => {
    const onChange = vi.fn();
    render(
      <DraftMarkdownEditor
        value={"Old title\nBody text"}
        onChange={onChange}
        onFile={vi.fn()}
        ariaLabel="Write a new note"
      />,
    );
    const guidance = screen.getByRole("textbox", { name: "Filing guidance" });
    fireEvent.change(guidance, { target: { value: "Project " } });
    expect(onChange).toHaveBeenLastCalledWith("Project \nBody text");
    fireEvent.change(guidance, { target: { value: "Project notes" } });
    expect(onChange).toHaveBeenLastCalledWith("Project notes\nBody text");
  });

  it("keeps legacy single-line selection offsets until the first body edit, then saves canonical offsets", () => {
    const onChange = vi.fn();
    const onSelectionChange = vi.fn();
    render(
      <DraftMarkdownEditor
        value="Legacy note"
        onChange={onChange}
        onFile={vi.fn()}
        onSelectionChange={onSelectionChange}
        ariaLabel="Write a new note"
      />,
    );
    const view = EditorView.findFromDOM(screen.getByLabelText("Write a new note"));
    act(() => view.dispatch({ selection: { anchor: 6 } }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(6, 6);

    act(() => view.dispatch({ changes: { from: 11, insert: "!" } }));
    expect(onChange).toHaveBeenLastCalledWith("\nLegacy note!");
    expect(onSelectionChange).toHaveBeenLastCalledWith(7, 7);
  });

  it("translates saved body selections after filing guidance changes", () => {
    const onSelectionChange = vi.fn();
    render(
      <DraftMarkdownEditor
        value={"A\nbody text"}
        onChange={vi.fn()}
        onFile={vi.fn()}
        onSelectionChange={onSelectionChange}
        ariaLabel="Write a new note"
        initialSelection={{ from: 3, to: 3 }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Filing guidance" }), {
      target: { value: "Longer title" },
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith(14, 14);
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

  it("files from guidance shortcuts and returns Enter or Escape to the body", () => {
    const onFile = vi.fn();
    render(
      <DraftMarkdownEditor
        value={"Title guidance\nBody stays here"}
        onChange={vi.fn()}
        onFile={onFile}
        ariaLabel="Write a new note"
      />,
    );
    const guidance = screen.getByRole("textbox", { name: "Filing guidance" });
    const view = EditorView.findFromDOM(screen.getByLabelText("Write a new note"));
    fireEvent.keyDown(guidance, { key: "Enter", metaKey: true });
    expect(onFile).toHaveBeenCalledOnce();
    fireEvent.keyDown(guidance, { key: "Escape" });
    expect(view.hasFocus).toBe(true);
    expect(view.state.doc.toString()).toBe("Body stays here");
    fireEvent.focus(guidance);
    fireEvent.keyDown(guidance, { key: "Enter" });
    expect(view.hasFocus).toBe(true);
    expect(view.state.doc.toString()).toBe("Body stays here");
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

  it("translates task line numbers past the serialized guidance line", () => {
    const onToggleTask = vi.fn();
    render(
      <DraftMarkdownEditor
        value={"File this separately\n- [ ] Draft task"}
        onChange={vi.fn()}
        onFile={vi.fn()}
        onToggleTask={onToggleTask}
        ariaLabel="Write a new note"
      />,
    );

    fireEvent.click(screen.getByLabelText("Toggle task on line 1"));
    expect(onToggleTask).toHaveBeenCalledWith(2, true);
  });
});
