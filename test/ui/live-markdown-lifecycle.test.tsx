import { redo, undo, undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toggleTaskAtLine } from "../../src/lib/workspace.ts";
import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";

afterEach(() => vi.restoreAllMocks());

function compositionFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  return () => act(() => frames.at(-1)?.(0));
}

describe("live editor document lifecycle", () => {
  it("preserves its view, local document, selection, and undo when presentation props change", () => {
    const onChange = vi.fn();
    const props = { value: "Note", onChange, ariaLabel: "Lifecycle note" };
    const { rerender } = render(<LiveMarkdownEditor {...props} placeholder="Write" />);
    const content = screen.getByLabelText("Lifecycle note");
    const view = EditorView.findFromDOM(content);
    act(() => view.dispatch({ changes: { from: 4, insert: "!" }, selection: { anchor: 5 } }));
    expect(undoDepth(view.state)).toBe(1);

    rerender(<LiveMarkdownEditor {...props} placeholder="Updated" autoFocus readOnly />);
    expect(EditorView.findFromDOM(content)).toBe(view);
    expect(content).toHaveAttribute("contenteditable", "false");
    expect(view.state.doc.toString()).toBe("Note!");
    expect(view.state.selection.main.head).toBe(5);
    expect(undoDepth(view.state)).toBe(1);
    content.dispatchEvent(new CustomEvent("folio-format", { detail: "bold" }));
    expect(view.state.doc.toString()).toBe("Note!");

    rerender(<LiveMarkdownEditor {...props} placeholder="Updated again" />);
    expect(EditorView.findFromDOM(content)).toBe(view);
    expect(content).toHaveAttribute("contenteditable", "true");
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("Note");
  });

  it("reconfigures placeholder and task interactivity without recreating the editor", () => {
    const onToggleTask = vi.fn();
    const props = { value: "", onChange: vi.fn(), ariaLabel: "Placeholder note", onToggleTask };
    const { rerender } = render(<LiveMarkdownEditor {...props} placeholder="First prompt" />);
    const content = screen.getByLabelText("Placeholder note");
    const view = EditorView.findFromDOM(content);
    expect(content).toHaveTextContent("First prompt");
    rerender(<LiveMarkdownEditor {...props} placeholder="Second prompt" />);
    expect(content).toHaveTextContent("Second prompt");
    rerender(<LiveMarkdownEditor {...props} value="- [ ] Task" readOnly />);
    expect(EditorView.findFromDOM(content)).toBe(view);
    expect(screen.getByRole("checkbox")).toBeDisabled();
    rerender(<LiveMarkdownEditor {...props} value="- [ ] Task" />);
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggleTask).toHaveBeenCalledWith(1, true);
  });

  it("keeps external snapshots exact and silent and starts a fresh undo document", () => {
    const onChange = vi.fn();
    const { rerender } = render(<LiveMarkdownEditor value="Original" onChange={onChange} ariaLabel="External note" />);
    const view = EditorView.findFromDOM(screen.getByLabelText("External note"));
    act(() => view.dispatch({ changes: { from: 8, insert: " local" }, selection: { anchor: 14, head: 10 } }));
    expect(onChange).toHaveBeenCalledOnce();
    const replacement = "10. intentional\n30. imported";
    rerender(<LiveMarkdownEditor value={replacement} onChange={onChange} ariaLabel="External note" />);
    expect(view.state.doc.toString()).toBe(replacement);
    expect(onChange).toHaveBeenCalledOnce();
    expect(undoDepth(view.state)).toBe(0);
    expect(undo(view)).toBe(false);
    expect(redo(view)).toBe(false);
    expect(view.state.selection.main.anchor).toBe(14);
    expect(view.state.selection.main.head).toBe(10);
    act(() => view.dispatch({ changes: { from: replacement.length, insert: "!" } }));
    expect(undoDepth(view.state)).toBe(1);
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(replacement);
  });

  it("protects pending typing from delayed echoes and accepts restores to acknowledged edits", () => {
    const onChange = vi.fn();
    const { rerender } = render(<LiveMarkdownEditor value="A" onChange={onChange} ariaLabel="Echo note" />);
    const view = EditorView.findFromDOM(screen.getByLabelText("Echo note"));
    act(() => {
      view.dispatch({ changes: { from: 1, insert: "B" } });
      view.dispatch({ changes: { from: 2, insert: "C" }, selection: { anchor: 3 } });
    });
    rerender(<LiveMarkdownEditor value="AB" onChange={onChange} ariaLabel="Echo note" />);
    expect(view.state.doc.toString()).toBe("ABC");
    expect(view.state.selection.main.head).toBe(3);
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    rerender(<LiveMarkdownEditor value="ABC" onChange={onChange} ariaLabel="Echo note" />);
    // Restoring a server revision keeps the editor mounted and can reuse a
    // previously acknowledged local value. This must replace the current text.
    rerender(<LiveMarkdownEditor value="AB" onChange={onChange} ariaLabel="Echo note" />);
    expect(view.state.doc.toString()).toBe("AB");
    expect(view.state.selection.main.head).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(undoDepth(view.state)).toBe(0);
  });

  it("clamps malformed restored selections and marker events to valid positions", () => {
    render(<LiveMarkdownEditor value="Note" onChange={vi.fn()} initialSelection={{ from: -9, to: 100 }} ariaLabel="Selection note" />);
    const content = screen.getByLabelText("Selection note");
    const view = EditorView.findFromDOM(content);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 4 });
    content.dispatchEvent(new CustomEvent("folio-select-list-content", { detail: Number.NaN }));
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 4 });
    content.dispatchEvent(new CustomEvent("folio-select-list-content", { detail: 100 }));
    expect(view.state.selection.main.head).toBe(4);
  });

  it("updates marker click offsets after earlier document lines move", () => {
    render(<LiveMarkdownEditor value={"Text\n- item"} onChange={vi.fn()} ariaLabel="Moving marker note" />);
    const view = EditorView.findFromDOM(screen.getByLabelText("Moving marker note"));
    act(() => view.dispatch({ changes: { from: 0, insert: "Longer " } }));
    fireEvent.mouseDown(document.querySelector(".cm-live-markdown-list-marker")!);
    expect(view.state.selection.main.head).toBe("Longer Text\n- ".length);
  });

  it("preserves list gaps on undo instead of normalizing the undo transaction", () => {
    render(<LiveMarkdownEditor value={"1. one\n3. three"} onChange={vi.fn()} ariaLabel="Undo note" />);
    const view = EditorView.findFromDOM(screen.getByLabelText("Undo note"));
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } }));
    expect(view.state.doc.toString()).toBe("1. one\n2. three!");
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("1. one\n3. three");
    act(() => { expect(redo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("1. one\n2. three!");
  });

  it("leaves indented code literal and excludes task shortcuts", () => {
    const onToggleTask = vi.fn();
    render(<LiveMarkdownEditor value="    - [ ] code task" onChange={vi.fn()} onToggleTask={onToggleTask} ariaLabel="Indented code" />);
    const content = screen.getByLabelText("Indented code");
    const view = EditorView.findFromDOM(content);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.querySelector(".cm-live-markdown-list")).toBeNull();
    act(() => view.dispatch({ selection: { anchor: 12 } }));
    fireEvent.keyDown(content, { key: " ", shiftKey: true });
    expect(onToggleTask).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("    - [ ] code task");
  });
});

describe("live editor composition", () => {
  it("retains unacknowledged composition and defers normalization until composition finishes", () => {
    const finishFrame = compositionFrames();
    const onChange = vi.fn();
    render(<LiveMarkdownEditor value={"1. one\n3. three"} onChange={onChange} ariaLabel="Composed note" />);
    const content = screen.getByLabelText("Composed note");
    const view = EditorView.findFromDOM(content);
    fireEvent.compositionStart(content);
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "文字" }, userEvent: "input.type.compose" }));
    expect(view.state.doc.toString()).toBe("1. one\n3. three文字");
    content.dispatchEvent(new CustomEvent("folio-format", { detail: "bold" }));
    expect(view.state.doc.toString()).toBe("1. one\n3. three文字");
    fireEvent.compositionEnd(content);
    finishFrame();
    expect(view.state.doc.toString()).toBe("1. one\n2. three文字");
    expect(onChange).toHaveBeenLastCalledWith("1. one\n2. three文字");
  });

  it("applies the latest deferred external snapshot after composition without echoing it", () => {
    const finishFrame = compositionFrames();
    const onChange = vi.fn();
    const { rerender } = render(<LiveMarkdownEditor value="Note" onChange={onChange} ariaLabel="Deferred note" />);
    const content = screen.getByLabelText("Deferred note");
    const view = EditorView.findFromDOM(content);
    fireEvent.compositionStart(content);
    act(() => view.dispatch({ changes: { from: 4, insert: "文字" }, userEvent: "input.type.compose" }));
    rerender(<LiveMarkdownEditor value="First external" onChange={onChange} ariaLabel="Deferred note" />);
    rerender(<LiveMarkdownEditor value={"10. final\n30. snapshot"} onChange={onChange} ariaLabel="Deferred note" />);
    expect(view.state.doc.toString()).toBe("Note文字");
    fireEvent.compositionEnd(content);
    finishFrame();
    expect(view.state.doc.toString()).toBe("10. final\n30. snapshot");
    expect(onChange).toHaveBeenCalledOnce();
    expect(undoDepth(view.state)).toBe(0);
  });
});

describe("consecutive native compositions", () => {
  it("cancels the previous finish frame before a new composition owns the document", () => {
    const finishFrame = compositionFrames();
    const onChange = vi.fn();
    const { rerender } = render(<LiveMarkdownEditor value="Note" onChange={onChange} ariaLabel="Sequential composition" />);
    const content = screen.getByLabelText("Sequential composition");
    const view = EditorView.findFromDOM(content);
    fireEvent.compositionStart(content);
    act(() => view.dispatch({ changes: { from: 4, insert: "文字" }, userEvent: "input.type.compose" }));
    rerender(<LiveMarkdownEditor value="External" onChange={onChange} ariaLabel="Sequential composition" />);
    fireEvent.compositionEnd(content);
    const obsoleteFrame = vi.mocked(window.requestAnimationFrame).mock.calls.at(-1)?.[0];
    fireEvent.compositionStart(content);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    act(() => obsoleteFrame?.(0));
    content.dispatchEvent(new CustomEvent("folio-format", { detail: "bold" }));
    expect(view.state.doc.toString()).toBe("Note文字");
    fireEvent.compositionEnd(content);
    finishFrame();
    expect(view.state.doc.toString()).toBe("External");
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("task edit history", () => {
  it.each(["checkbox", "keyboard"] as const)("records %s toggles once and keeps preceding typing undoable", (interaction) => {
    const onChange = vi.fn();
    const onToggleTask = vi.fn();
    function ControlledTaskNote() {
      const [value, setValue] = useState("- [ ] Task\nPlain");
      return <LiveMarkdownEditor value={value} ariaLabel="Controlled task history"
        onChange={(next) => { onChange(next); setValue(next); }}
        onToggleTask={(lineNumber, checked) => {
          onToggleTask(lineNumber, checked);
          const next = toggleTaskAtLine(value, lineNumber, checked);
          if (next !== null) setValue(next);
        }} />;
    }
    render(<ControlledTaskNote />);
    const content = screen.getByLabelText("Controlled task history");
    const view = EditorView.findFromDOM(content);
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "!" }, selection: { anchor: view.state.doc.length + 1 }, userEvent: "input" }));
    const caret = view.state.selection.main.head;
    if (interaction === "checkbox") {
      fireEvent.click(screen.getByRole("checkbox"));
      expect(view.state.selection.main.head).toBe(caret);
    } else {
      act(() => view.dispatch({ selection: { anchor: 7 } }));
      fireEvent.keyDown(content, { key: " ", shiftKey: true });
    }
    expect(view.state.doc.toString()).toBe("- [x] Task\nPlain!");
    expect(onToggleTask).toHaveBeenCalledExactlyOnceWith(1, true);
    expect(onChange).toHaveBeenCalledOnce();
    expect(undoDepth(view.state)).toBe(2);
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("- [ ] Task\nPlain!");
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("- [ ] Task\nPlain");
    expect(onToggleTask).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
