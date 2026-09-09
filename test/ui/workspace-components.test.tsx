import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { DocumentFooter } from "../../src/features/workspace/components/DocumentFooter.tsx";
import { DocumentHeader } from "../../src/features/workspace/components/DocumentHeader.tsx";
import { DocumentPane } from "../../src/features/workspace/components/DocumentPane.tsx";
import { FilingConfirmation } from "../../src/features/workspace/components/FilingConfirmation.tsx";
import { EditorGroup } from "../../src/features/workspace/components/EditorGroup.tsx";
import { RenderedMarkdown } from "../../src/features/workspace/components/RenderedMarkdown.tsx";
import { WorkspaceSplitHandle } from "../../src/features/workspace/components/WorkspaceSplitHandle.tsx";
import { useWorkspaceEditorUi } from "../../src/features/workspace/hooks/useWorkspaceEditorUi.ts";
import type { FilingQueueEntry } from "../../src/features/workspace/model/filing.ts";

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
  it("moves from preparing to a ready filing dialog without changing hook order", () => {
    const entry = {
      filing: {
        id: "filing-preparing",
        draftId: "untitled-preparing",
        mode: "new",
        destinationId: null,
        actor: "agent",
        proposal: { directory: "/projects", filename: "prepared.md", title: "Prepared", description: "", tags: [] },
      },
      fields: { directory: "/projects", title: "Prepared", description: "", tags: [] },
      standalone: false,
      status: "preparing",
      error: null,
    } satisfies FilingQueueEntry;
    const props = {
      directories: ["/", "/projects"],
      onChange: vi.fn(), onAccept: vi.fn(), onStandalone: vi.fn(), onDismiss: vi.fn(), onRevealStandalone: vi.fn(),
    };
    const { rerender } = render(<FilingConfirmation entry={entry} {...props} />);

    expect(screen.getByText("Filing note…")).toBeInTheDocument();
    rerender(<FilingConfirmation entry={{ ...entry, status: "ready" }} {...props} />);
    expect(screen.getByRole("heading", { name: "Review filing" })).toBeInTheDocument();
  });

  it("confirms filing proposals in the note and exposes independent fields", () => {
    const onChange = vi.fn();
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(
      <FilingConfirmation
        directories={["/", "/projects", "/projects/website", "/projects/writing"]}
        entry={{
          filing: {
            id: "filing-1",
            draftId: "untitled-1",
            mode: "new",
            destinationId: null,
            actor: "agent",
            proposal: {
              directory: "/projects",
              filename: "launch.md",
              title: "Launch plan",
              description: "Publish it",
              tags: ["project"],
            },
          },
          fields: {
            directory: "/projects",
            title: "Launch plan",
            description: "Publish it",
            tags: ["project"],
          },
          standalone: false,
          status: "ready",
          error: null,
        }}
        onChange={onChange}
        onAccept={onAccept}
        onStandalone={vi.fn()}
        onDismiss={onDismiss}
        onRevealStandalone={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Accept" })).toHaveFocus();
    expect(screen.queryByLabelText("Filename")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Published plan" },
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      directory: "/projects",
      title: "Published plan",
      description: "Publish it",
      tags: ["project"],
    }));
    expect(screen.getByRole("combobox", { name: "Path" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });
    expect(onAccept).toHaveBeenCalledOnce();
    fireEvent.keyDown(window.document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
    fireEvent.pointerDown(window.document.body);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps filing dialogs independent across notes", () => {
    const firstDismiss = vi.fn();
    const secondDismiss = vi.fn();
    const sharedEntry = {
      filing: {
        id: "filing-shared",
        draftId: "untitled-shared",
        mode: "new" as const,
        destinationId: null,
        actor: "agent",
        proposal: { directory: "/projects", filename: "note.md", title: "Note", description: "", tags: [] },
      },
      fields: { directory: "/projects", title: "Note", description: "", tags: [] },
      standalone: false,
      status: "ready" as const,
      error: null,
    };

    render(
      <>
        <FilingConfirmation
          entry={sharedEntry}
          directories={["/", "/projects"]}
          autoFocus={false}
          onChange={vi.fn()}
          onAccept={vi.fn()}
          onStandalone={vi.fn()}
          onDismiss={firstDismiss}
          onRevealStandalone={vi.fn()}
        />
        <FilingConfirmation
          entry={{ ...sharedEntry, filing: { ...sharedEntry.filing, id: "filing-active" } }}
          directories={["/", "/projects"]}
          onChange={vi.fn()}
          onAccept={vi.fn()}
          onStandalone={vi.fn()}
          onDismiss={secondDismiss}
          onRevealStandalone={vi.fn()}
        />
      </>,
    );

    const pathInputs = screen.getAllByRole("combobox", { name: "Path" });
    expect(pathInputs[0].getAttribute("aria-controls")).not.toBe(pathInputs[1].getAttribute("aria-controls"));
    fireEvent.keyDown(window.document, { key: "Escape" });
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(secondDismiss).toHaveBeenCalledOnce();
  });

  it("selects a depth-scoped path suggestion with the keyboard", () => {
    const onChange = vi.fn();
    render(
      <FilingConfirmation
        directories={["/", "/projects", "/projects/website", "/projects/writing", "/references"]}
        entry={{
          filing: {
            id: "filing-path",
            draftId: "untitled-path",
            mode: "new",
            destinationId: null,
            actor: "agent",
            proposal: { directory: "/projects/we", filename: "launch.md", title: "Launch", description: "", tags: [] },
          },
          fields: { directory: "/projects/we", title: "Launch", description: "", tags: [] },
          standalone: false,
          status: "ready",
          error: null,
        }}
        onChange={onChange}
        onAccept={vi.fn()}
        onStandalone={vi.fn()}
        onDismiss={vi.fn()}
        onRevealStandalone={vi.fn()}
      />,
    );

    const pathInput = screen.getByRole("combobox", { name: "Path" });
    pathInput.focus();
    pathInput.setSelectionRange(12, 12);
    fireEvent.click(pathInput);

    expect(screen.getByRole("option", { name: "/projects/website" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "/references" })).not.toBeInTheDocument();
    fireEvent.keyDown(pathInput, { key: "Tab" });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      directory: "/projects/website",
    }));
    expect(screen.queryByRole("button", { name: "Keep agent filing" })).not.toBeInTheDocument();
  });

  it("prevents filing into the internal references directory", () => {
    const onAccept = vi.fn();
    render(
      <FilingConfirmation
        directories={["/", "/projects"]}
        entry={{
          filing: {
            id: "filing-reserved",
            draftId: "untitled-reserved",
            mode: "new",
            destinationId: null,
            actor: "agent",
            proposal: { directory: "/references/inbox", filename: "note.md", title: "Note", description: "", tags: [] },
          },
          fields: { directory: "/references/inbox", title: "Note", description: "", tags: [] },
          standalone: false,
          status: "ready",
          error: null,
        }}
        onChange={vi.fn()}
        onAccept={onAccept}
        onStandalone={vi.fn()}
        onDismiss={vi.fn()}
        onRevealStandalone={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("References is an internal folder");
    expect(screen.getByRole("combobox", { name: "Path" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Path" }), { key: "Enter" });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("offers a separate proposal for append filing", () => {
    const onReveal = vi.fn();
    render(
      <FilingConfirmation
        directories={["/", "/projects"]}
        entry={{
          filing: {
            id: "filing-append",
            draftId: "untitled-2",
            mode: "existing",
            destinationId: "/projects/launch.md",
            actor: "agent",
            proposal: { directory: "/projects", filename: "launch.md", title: "Launch", description: "", tags: [] },
            standaloneProposal: { directory: "/projects", filename: "separate.md", title: "Separate", description: "", tags: [] },
          },
          fields: { directory: "/projects", title: "Launch", description: "", tags: [] },
          standalone: false,
          status: "ready",
          error: null,
        }}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onStandalone={vi.fn()}
        onDismiss={vi.fn()}
        onRevealStandalone={onReveal}
      />,
    );
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("/projects")).toBeInTheDocument();
    expect(screen.queryByText("/projects/launch.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "File separately" }));
    expect(onReveal).toHaveBeenCalledOnce();
  });

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

  it("keeps editing controls available and quiet during autosave", () => {
    render(
      <>
        <DocumentHeader
          groupId="primary"
          document={document}
          editingKey={null}
          drafts={{}}
          onBeginEditing={vi.fn()}
          onChangeDraft={vi.fn()}
          onFinishEditing={vi.fn()}
        />
        <DocumentFooter
          groupId="primary"
          document={document}
          draft={undefined}
          pathDraft={undefined}
          tagDraft={undefined}
          saving
          deleting={false}
          deleteInProgress={false}
          moving={false}
          onBeginPathEditing={vi.fn()}
          onChangePath={vi.fn()}
          onFinishPathEditing={vi.fn()}
          onResetPath={vi.fn()}
          onBeginTagEditing={vi.fn()}
          onChangeTag={vi.fn()}
          onFinishTagEditing={vi.fn()}
          onFileDraft={vi.fn()}
          onDelete={vi.fn().mockResolvedValue(undefined)}
          onOpenDocument={vi.fn().mockResolvedValue(undefined)}
        />
      </>,
    );

    expect(screen.getByRole("button", { name: "Current note" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Description" })).toBeEnabled();
    expect(screen.getByLabelText("Path for Current note")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
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

  it("renders GFM strikethrough and heading levels", () => {
    render(
      <RenderedMarkdown
        document={{
          ...document,
          content: "# First\n\n## Second\n\n### Third\n\n~~Removed~~",
        }}
        groupId="secondary"
        saving={false}
        onOpenDocument={vi.fn().mockResolvedValue(undefined)}
        onToggleTask={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("heading", { name: "First", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Second", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Third", level: 3 })).toBeTruthy();
    expect(screen.getByText("Removed").tagName).toBe("DEL");
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
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete note" })).toHaveTextContent(
      "The raw capture will be retained",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
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
