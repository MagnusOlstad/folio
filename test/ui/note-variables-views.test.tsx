import { render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { RenderedMarkdown } from "../../src/features/workspace/components/RenderedMarkdown.tsx";
import { noteExportSnapshot } from "../../src/features/workspace/model/note-export.ts";
import { setLiveMarkdownFocus } from "../../src/features/workspace/model/live-markdown.ts";

const note: ViewerDocument = {
  id: "/notes/current.md",
  title: "Meeting",
  type: "Note",
  description: "",
  tags: [],
  createdAt: "2026-09-06T08:00:00.000Z",
  content: "speaker1:: Kari\n\n**{{speaker1}}** said {{ missing }} and `{{speaker1}}`",
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

describe("note variables in views", () => {
  it("renders resolved values and the display form of definitions", () => {
    const { container } = render(
      <RenderedMarkdown
        document={note}
        groupId="main"
        saving={false}
        onOpenDocument={vi.fn()}
        onToggleTask={vi.fn()}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("speaker1: Kari");
    expect(text).not.toContain("speaker1::");
    expect(container.querySelector("strong")?.textContent).toBe("Kari");
    expect(text).toContain("{{ missing }}");
    expect(container.querySelector("code")?.textContent).toBe("{{speaker1}}");
  });

  it("resolves variables in export snapshots", () => {
    const snapshot = noteExportSnapshot(note, undefined);
    expect(snapshot.content).toBe(
      "speaker1: Kari\n\n**Kari** said {{ missing }} and `{{speaker1}}`",
    );
  });

  it("shows values in the live editor until the cursor touches the reference", () => {
    render(
      <LiveMarkdownEditor
        value={"speaker1:: Kari\n{{speaker1}} {{nobody}}"}
        onChange={vi.fn()}
        ariaLabel="Variable note"
      />,
    );
    const editor = screen.getByLabelText("Variable note");
    const view = EditorView.findFromDOM(editor)!;
    const widget = editor.querySelector<HTMLElement>(".cm-live-markdown-variable");
    expect(widget?.textContent).toBe("Kari");
    expect(widget?.title).toBe("speaker1 = Kari");
    expect(editor.querySelector(".cm-live-markdown-variable-undefined")?.textContent).toBe("{{nobody}}");
    expect(editor.querySelector(".cm-live-markdown-variable-key")?.textContent).toBe("speaker1");
    view.dispatch({ effects: setLiveMarkdownFocus.of(true), selection: { anchor: 20 } });
    expect(editor.querySelector(".cm-live-markdown-variable")).toBeNull();
    expect(view.state.doc.toString()).toContain("{{speaker1}}");
  });
});
