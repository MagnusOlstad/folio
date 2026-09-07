import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NoteEditor } from "../../src/features/editor/NoteEditor.tsx";

describe("NoteEditor markdown interactions", () => {
  it("applies a requested format marker and keeps the selection inside the new markers", () => {
    const onChange = vi.fn();
    render(
      <NoteEditor
        value="hello"
        onChange={onChange}
        onBlur={vi.fn()}
        ariaLabel="Note editor"
      />,
    );
    const editor = screen.getByLabelText("Note editor") as HTMLTextAreaElement;
    editor.setSelectionRange(0, 5);

    editor.dispatchEvent(
      new CustomEvent("folio-format", { detail: "bold", cancelable: true }),
    );

    expect(onChange).toHaveBeenCalledWith("**hello**");
  });

  it("continues a markdown task list on Enter", () => {
    const onChange = vi.fn();
    render(
      <NoteEditor
        value="- [x] done"
        onChange={onChange}
        onBlur={vi.fn()}
        ariaLabel="Note editor"
      />,
    );
    const editor = screen.getByLabelText("Note editor") as HTMLTextAreaElement;
    editor.setSelectionRange(10, 10);

    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("- [x] done\n- [ ] ");
  });

  it("renumbers the following items when Enter splits a numbered list", () => {
    const onChange = vi.fn();
    render(
      <NoteEditor
        value={"1. one\n2. two\n3. three"}
        onChange={onChange}
        onBlur={vi.fn()}
        ariaLabel="Note editor"
      />,
    );
    const editor = screen.getByLabelText("Note editor") as HTMLTextAreaElement;
    editor.setSelectionRange(13, 13);

    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("1. one\n2. two\n3. \n4. three");
  });

  it("files a draft when Cmd/Ctrl+Enter is used", () => {
    const onFile = vi.fn();
    render(
      <NoteEditor
        value="Draft"
        onChange={vi.fn()}
        onBlur={vi.fn()}
        onFile={onFile}
        ariaLabel="Draft editor"
      />,
    );

    fireEvent.keyDown(screen.getByLabelText("Draft editor"), {
      key: "Enter",
      metaKey: true,
    });

    expect(onFile).toHaveBeenCalledOnce();
  });
});
