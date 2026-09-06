import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { act, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { DocumentFooter } from "../../src/features/workspace/components/DocumentFooter.tsx";
import { DocumentHeader } from "../../src/features/workspace/components/DocumentHeader.tsx";
import { DocumentPane } from "../../src/features/workspace/components/DocumentPane.tsx";
import { EditorGroup } from "../../src/features/workspace/components/EditorGroup.tsx";
import { RenderedMarkdown } from "../../src/features/workspace/components/RenderedMarkdown.tsx";
import { WorkspaceSplitHandle } from "../../src/features/workspace/components/WorkspaceSplitHandle.tsx";
import { useWorkspaceEditorUi } from "../../src/features/workspace/hooks/useWorkspaceEditorUi.ts";

const document: ViewerDocument = {
  id: "/notes/current.md",
  title: "Current note",
  type: "Note",
  description: "Description",
  tags: ["one"],
  createdAt: "2026-09-06T08:00:00.000Z",
  content: "[Other](other.md)\n\n- [ ] Task",
  deletable: true,
  movable: true,
  status: "stable",
  staleAfter: null,
  stale: false,
  filedBy: "human:test",
  filedAt: "2026-09-06T08:00:00.000Z",
  links: [],
  backlinks: [],
  suggestions: [],
};

describe("workspace editor components", () => {
  it("resizes split groups from the keyboard and resets on double click", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    render(
      <div>
        <WorkspaceSplitHandle
          splitPosition={50}
          onPointerDown={vi.fn()}
          onResize={onResize}
          onPointerEnd={vi.fn()}
          onReset={onReset}
        />
      </div>,
    );
    const handle = screen.getByRole("separator");
    Object.defineProperty(handle, "offsetWidth", { value: 10 });
    vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 0,
      width: 100,
      height: 100,
      top: 0,
      right: 110,
      bottom: 100,
      left: 10,
      toJSON: () => ({}),
    });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.doubleClick(handle);

    expect(onResize).toHaveBeenCalledWith(56.8, handle);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("commits metadata edits on blur and restores the original on Escape", () => {
    const finish = vi.fn();
    const { rerender } = render(
      <DocumentHeader
        groupId="primary"
        document={document}
        saving={false}
        editingKey="primary:/notes/current.md:title"
        drafts={{ "primary:/notes/current.md:title": "Changed" }}
        onBeginEditing={vi.fn()}
        onChangeDraft={vi.fn()}
        onFinishEditing={finish}
      />,
    );
    const title = screen.getByLabelText("Title for Current note");
    fireEvent.blur(title);
    expect(finish).toHaveBeenCalledWith(
      "primary:/notes/current.md:title",
      document,
      "title",
      "Changed",
    );

    rerender(
      <DocumentHeader
        groupId="primary"
        document={document}
        saving={false}
        editingKey="primary:/notes/current.md:description"
        drafts={{ "primary:/notes/current.md:description": "Changed" }}
        onBeginEditing={vi.fn()}
        onChangeDraft={vi.fn()}
        onFinishEditing={finish}
      />,
    );
    const description = screen.getByLabelText("Description for Current note");
    fireEvent.keyDown(description, { key: "Escape" });
    expect(finish).toHaveBeenLastCalledWith(
      "primary:/notes/current.md:description",
      document,
      "description",
      "Description",
    );
  });

  it("renders loading and empty pane states without mounting a document", () => {
    const onCreate = vi.fn();
    const { rerender } = render(
      <DocumentPane
        groupId="primary"
        hasDocument={false}
        loading
        onCreateNewTab={onCreate}
      >
        {null}
      </DocumentPane>,
    );
    expect(screen.getByText("Opening file...")).toBeInTheDocument();

    rerender(
      <DocumentPane
        groupId="primary"
        hasDocument={false}
        loading={false}
        onCreateNewTab={onCreate}
      >
        {null}
      </DocumentPane>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onCreate).toHaveBeenCalledWith("primary");
  });

  it("opens internal Markdown links and forwards task checkbox changes", () => {
    const onOpen = vi.fn().mockResolvedValue(undefined);
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(
      <RenderedMarkdown
        document={document}
        groupId="secondary"
        saving={false}
        onOpenDocument={onOpen}
        onToggleTask={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Other" }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect(onOpen).toHaveBeenCalledWith(
      "/notes/other.md",
      "file",
      "secondary",
    );
    expect(onToggle).toHaveBeenCalledWith(document, 3, true);
  });

  it("forwards document path, tag, delete, and related-link actions", () => {
    const linkedDocument = {
      ...document,
      links: [
        {
          id: "/notes/linked.md",
          title: "Linked note",
          type: "Note",
          description: "",
          createdAt: "2026-09-05T08:00:00.000Z",
          relation: "related",
          origin: "frontmatter" as const,
        },
      ],
    };
    const move = vi.fn().mockResolvedValue(undefined);
    const persist = vi.fn();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onOpen = vi.fn().mockResolvedValue(undefined);

    function FooterHarness() {
      const ui = useWorkspaceEditorUi();
      return (
        <DocumentFooter
          groupId="primary"
          document={linkedDocument}
          draft={undefined}
          pathDraft={ui.pathDrafts[linkedDocument.id]}
          tagDraft={ui.tagDrafts[linkedDocument.id]}
          saving={false}
          deleting={false}
          deleteInProgress={false}
          moving={false}
          onBeginPathEditing={ui.beginPathEditing}
          onChangePath={ui.changePathDraft}
          onFinishPathEditing={(target, value) =>
            ui.finishPathEditing(target, value, move)
          }
          onResetPath={ui.resetPathDraft}
          onBeginTagEditing={ui.beginTagEditing}
          onChangeTag={ui.changeTagDraft}
          onFinishTagEditing={(target, value) =>
            ui.finishTagEditing(target, value, persist)
          }
          onFileDraft={vi.fn()}
          onDelete={onDelete}
          onOpenDocument={onOpen}
        />
      );
    }

    render(<FooterHarness />);

    const path = screen.getByLabelText("Path for Current note");
    fireEvent.focus(path);
    fireEvent.change(path, { target: { value: "/archive" } });
    fireEvent.blur(path);
    const tags = screen.getByLabelText("Tags for Current note");
    fireEvent.focus(tags);
    fireEvent.change(tags, { target: { value: "one, two" } });
    fireEvent.blur(tags);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: /Linked note/ }));

    expect(move).toHaveBeenCalledWith(document.id, "/archive");
    expect(persist).toHaveBeenCalledWith(
      linkedDocument,
      linkedDocument.content,
      ["one", "two"],
    );
    expect(onDelete).toHaveBeenCalledWith(linkedDocument);
    expect(onOpen).toHaveBeenCalledWith(
      "/notes/linked.md",
      "file",
      "primary",
    );
  });

  it("moves a dropped tab through the editor-group action contract", () => {
    const moveTabToGroup = vi.fn();

    function GroupHarness() {
      const ui = useWorkspaceEditorUi();
      const editorIntents = useRef({});
      return (
        <EditorGroup
          group={{ id: "secondary", tabs: [], activeId: null }}
          groupCount={2}
          model={{
            activeGroupId: "primary",
            documents: {},
            loadingDocuments: new Set(),
            savingDocuments: new Set(),
            editingKey: null,
            editorIntents,
            drafts: {},
            deletingNoteId: null,
            movingFileId: null,
          }}
          actions={{
            activateGroup: vi.fn(),
            moveTabToGroup,
            titleForId: (id) => id,
            activateTab: vi.fn(),
            createNewTab: vi.fn(),
            splitWorkspace: vi.fn(),
            closeGroup: vi.fn(),
            closeTab: vi.fn(),
            changeDraftContent: vi.fn(),
            fileDraft: vi.fn(),
            beginEditing: vi.fn(),
            finishEditing: vi.fn(),
            restoreReaderScroll: vi.fn(),
            openDocument: vi.fn().mockResolvedValue(undefined),
            toggleTaskCheckbox: vi.fn().mockResolvedValue(undefined),
            deleteFiledNote: vi.fn().mockResolvedValue(undefined),
            persistDocument: vi.fn(),
            persistMetadata: vi.fn(),
            moveBundleFile: vi.fn().mockResolvedValue(undefined),
          }}
          ui={ui}
        />
      );
    }

    const { container } = render(<GroupHarness />);
    fireEvent.drop(container.querySelector(".editor-group")!, {
      dataTransfer: {
        getData: () =>
          JSON.stringify({
            documentId: "/notes/current.md",
            groupId: "primary",
          }),
      },
    });

    expect(moveTabToGroup).toHaveBeenCalledWith(
      "/notes/current.md",
      "primary",
      "secondary",
    );
  });

  it("keeps metadata, path, tag, and drag state inside the workspace hook", () => {
    const { result } = renderHook(() => useWorkspaceEditorUi());
    act(() => {
      result.current.setDraggedTab({
        documentId: document.id,
        groupId: "primary",
      });
      result.current.beginMetadataEditing(
        "primary",
        document,
        "title",
        false,
      );
      result.current.beginPathEditing(document);
      result.current.beginTagEditing(document);
    });

    expect(result.current.draggedTab?.documentId).toBe(document.id);
    expect(result.current.editingMetadataKey).toBe(
      "primary:/notes/current.md:title",
    );
    expect(result.current.pathDrafts[document.id]).toBe("/notes");
    expect(result.current.tagDrafts[document.id]).toBe("one");
  });
});
