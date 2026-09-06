import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DraftMarkdownEditor } from "../../src/features/workspace/components/DraftMarkdownEditor.tsx";

describe("DraftMarkdownEditor", () => {
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
});
