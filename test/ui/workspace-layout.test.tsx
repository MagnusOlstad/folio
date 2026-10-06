import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSidebarHandle } from "../../src/features/workspace/components/WorkspaceSidebarHandle.tsx";
import { WorkspaceLeftPaneHeader } from "../../src/features/workspace/components/WorkspaceLeftPaneHeader.tsx";
import { WorkspaceRightPane } from "../../src/features/workspace/components/WorkspaceRightPane.tsx";
import { useWorkspaceLayout } from "../../src/features/workspace/hooks/useWorkspaceLayout.ts";

describe("workspace pane layout", () => {
  it("keeps both panes independently collapsible", () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    expect(result.current.sidebarOpen).toBe(true);
    expect(result.current.rightPaneOpen).toBe(true);

    act(() => {
      result.current.setSidebarOpen(false);
      result.current.setRightPaneOpen(false);
    });

    expect(result.current.sidebarOpen).toBe(false);
    expect(result.current.rightPaneOpen).toBe(false);
  });

  it("starts narrow windows with the right pane closed and preserves choices when resized", () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });

    try {
      const { result, unmount } = renderHook(() => useWorkspaceLayout());
      expect(result.current.sidebarOpen).toBe(true);
      expect(result.current.rightPaneOpen).toBe(false);

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });
      fireEvent.resize(window);
      expect(result.current.rightPaneOpen).toBe(false);

      act(() => result.current.setRightPaneOpen(true));
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
      fireEvent.resize(window);
      expect(result.current.rightPaneOpen).toBe(true);
      unmount();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("keeps app identity and the left pane toggle in its header", () => {
    const toggle = vi.fn();
    render(
      <WorkspaceLeftPaneHeader
        onOpenSettings={() => {}}
        sidebarOpen
        onToggleSidebar={toggle}
      />,
    );

    expect(screen.getByRole("link", { name: "FolioNotes home" })).toBeInTheDocument();
    expect(screen.queryByText("v1.2.3")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide left sidebar" }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("keeps the right pane available with MLX model status below", () => {
    render(
      <WorkspaceRightPane
        mlxStatus={null}
        mlxActionModel={null}
        onInstallMlxModel={() => {}}
        onToggleMlxModel={() => {}}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Workspace tools" })).toBeInTheDocument();
    expect(screen.getByText("MLX checking")).toBeInTheDocument();
    expect(screen.getByText("Gemma 4 E4B")).toBeInTheDocument();
    expect(screen.getByText("EmbeddingGemma")).toBeInTheDocument();
    expect(screen.queryByText(/helper|choose install|features load installed models/i)).not.toBeInTheDocument();
  });

  it("resizes the right pane from its inside edge and supports keyboard control", () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    const handle = document.createElement("div");
    const workspace = document.createElement("div");
    workspace.append(handle);
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 1_200, height: 600, top: 0, left: 0, right: 1_200, bottom: 600, toJSON: () => ({}),
    });

    act(() => result.current.resizeRightPane(900, handle));
    expect(result.current.rightPaneWidth).toBe(300);

    const onResize = vi.fn();
    render(<div><WorkspaceSidebarHandle width={300} side="right" onPointerDown={vi.fn()} onResize={onResize} onPointerEnd={vi.fn()} onReset={vi.fn()} /></div>);
    const separator = screen.getByRole("separator");
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600, toJSON: () => ({}),
    });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith(616, separator);
  });

  it("uses the right pane's rendered width for its initial keyboard resize", () => {
    const onResize = vi.fn();
    render(
      <div>
        <WorkspaceSidebarHandle width={null} side="right" onPointerDown={vi.fn()} onResize={onResize} onPointerEnd={vi.fn()} onReset={vi.fn()} />
        <button type="button" aria-label="Show left sidebar" />
        <aside className="workspace-right-pane" data-testid="right-pane" />
      </div>,
    );
    const separator = screen.getByRole("separator", { name: "Resize right sidebar" });
    const workspace = separator.parentElement!;
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600, toJSON: () => ({}),
    });
    vi.spyOn(screen.getByTestId("right-pane"), "getBoundingClientRect").mockReturnValue({
      x: 630, y: 0, width: 270, height: 600, top: 0, left: 630, right: 900, bottom: 600, toJSON: () => ({}),
    });

    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(onResize).toHaveBeenCalledWith(646, separator);
  });
});
