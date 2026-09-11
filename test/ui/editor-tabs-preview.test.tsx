import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorTabs } from "../../src/features/tabs/EditorTabs.tsx";

describe("EditorTabs preview tabs", () => {
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
});
