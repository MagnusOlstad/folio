import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorTabs } from "../../src/features/tabs/EditorTabs.tsx";

describe("EditorTabs preview tabs", () => {
  it("keeps pane toggles in a reserved control slot beside the editor actions", () => {
    const onToggleLeft = vi.fn();
    const onToggleRight = vi.fn();
    const { container, rerender } = render(
      <EditorTabs
        group={{ id: "primary", tabs: [], activeId: null, previewId: null }}
        groupCount={1}
        titleForId={(id) => id}
        isUntitledId={() => false}
        onActivate={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
        onSplit={vi.fn()}
        onCloseGroup={vi.fn()}
        onPinTab={vi.fn()}
        paneControls={{ leftOpen: false, rightOpen: false, onToggleLeft, onToggleRight }}
      />,
    );

    const leftControlSlot = container.querySelector(".editor-pane-control-left");
    const rightControlSlot = container.querySelector(".editor-pane-control-right");
    expect(leftControlSlot).toContainElement(screen.getByRole("button", { name: "Show left sidebar" }));
    expect(rightControlSlot).toContainElement(screen.getByRole("button", { name: "Show right sidebar" }));
    expect(rightControlSlot?.previousElementSibling).toHaveClass("group-actions");
    expect(screen.getByTitle("Split editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show left sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Show right sidebar" }));
    expect(onToggleLeft).toHaveBeenCalledOnce();
    expect(onToggleRight).toHaveBeenCalledOnce();

    rerender(
      <EditorTabs
        group={{ id: "primary", tabs: [], activeId: null, previewId: null }}
        groupCount={1}
        titleForId={(id) => id}
        isUntitledId={() => false}
        onActivate={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
        onSplit={vi.fn()}
        onCloseGroup={vi.fn()}
        onPinTab={vi.fn()}
        paneControls={{ leftOpen: true, rightOpen: true, onToggleLeft, onToggleRight }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Show left sidebar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show right sidebar" })).not.toBeInTheDocument();
  });

  it("marks only the preview title as italic and pins it on double-click", () => {
    const onPinTab = vi.fn();
    render(
      <EditorTabs
        group={{
          id: "primary",
          tabs: ["permanent", "preview"],
          activeId: "preview",
          previewId: "preview",
        }}
        groupCount={1}
        titleForId={(id) => id}
        isUntitledId={() => false}
        onActivate={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
        onSplit={vi.fn()}
        onCloseGroup={vi.fn()}
        onPinTab={onPinTab}
      />,
    );

    const previewTab = screen.getByTitle("preview");
    expect(previewTab).toHaveClass("preview");
    expect(screen.getByText("preview")).toHaveClass("tab-title");
    expect(screen.getByTitle("permanent")).not.toHaveClass("preview");

    fireEvent.doubleClick(previewTab);
    expect(onPinTab).toHaveBeenCalledWith("primary", "preview");
  });

  it("forwards tab drops to support reordering within a group", () => {
    const onDropTab = vi.fn();
    render(
      <EditorTabs
        group={{ id: "primary", tabs: ["first", "second"], activeId: "first", previewId: null }}
        groupCount={1}
        titleForId={(id) => id}
        isUntitledId={() => false}
        onActivate={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onDropTab={onDropTab}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
        onSplit={vi.fn()}
        onCloseGroup={vi.fn()}
        onPinTab={vi.fn()}
      />,
    );

    fireEvent.drop(screen.getByTitle("second"), {
      dataTransfer: { getData: () => "" },
    });
    expect(onDropTab).toHaveBeenCalledWith(
      expect.anything(),
      "second",
      "primary",
    );
  });
});
