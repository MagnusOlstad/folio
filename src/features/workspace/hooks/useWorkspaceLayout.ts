import { useState } from "react";
import type { PointerEvent } from "react";

export function useWorkspaceLayout() {
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [splitPosition, setSplitPosition] = useState(50);

  function beginHorizontalResize(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-horizontal");
  }

  function finishHorizontalResize(event: PointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("resizing-horizontal");
  }

  function resizeSidebar(clientX: number, handle: HTMLElement) {
    const workspace = handle.parentElement;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    const maxWidth = Math.max(220, Math.min(520, bounds.width - 420));
    setSidebarWidth(
      Math.round(Math.min(maxWidth, Math.max(220, clientX - bounds.left))),
    );
  }

  function resizeSplit(clientX: number, handle: HTMLElement) {
    const workspace = handle.parentElement;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    const availableWidth = bounds.width - handle.offsetWidth;
    const minimumPaneWidth = Math.min(280, availableWidth / 2);
    const leftWidth = Math.min(
      availableWidth - minimumPaneWidth,
      Math.max(minimumPaneWidth, clientX - bounds.left),
    );
    setSplitPosition((leftWidth / availableWidth) * 100);
  }

  return {
    sidebarWidth,
    setSidebarWidth,
    splitPosition,
    setSplitPosition,
    beginHorizontalResize,
    finishHorizontalResize,
    resizeSidebar,
    resizeSplit,
  };
}
