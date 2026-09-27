import type { PointerEvent } from "react";

type WorkspaceSidebarHandleProps = {
  width: number | null;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onResize: (clientX: number, handle: HTMLElement) => void;
  onPointerEnd: (event: PointerEvent<HTMLElement>) => void;
  onReset: () => void;
  side?: "left" | "right";
};

export function WorkspaceSidebarHandle({
  width,
  onPointerDown,
  onResize,
  onPointerEnd,
  onReset,
  side = "left",
}: WorkspaceSidebarHandleProps) {
  return (
    <div
      className={`horizontal-resize-handle sidebar-resize-handle ${side === "right" ? "right-pane-resize-handle" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={side === "right" ? "Resize right sidebar" : "Resize sidebar"}
      aria-orientation="vertical"
      aria-valuemin={220}
      aria-valuemax={520}
      aria-valuenow={width ?? undefined}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          onResize(event.clientX, event.currentTarget);
      }}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const adjacentPane = side === "right"
          ? event.currentTarget.parentElement?.querySelector(".workspace-right-pane")
          : event.currentTarget.previousElementSibling;
        const currentWidth = width ?? adjacentPane?.getBoundingClientRect().width ?? 310;
        const workspaceBounds = event.currentTarget.parentElement?.getBoundingClientRect();
        const workspaceLeft = workspaceBounds?.left || 0;
        const movement = event.key === "ArrowLeft" ? -16 : 16;
        onResize(
          side === "right"
            ? (workspaceBounds?.right || 0) - currentWidth + movement
            : workspaceLeft + currentWidth + movement,
          event.currentTarget,
        );
      }}
    />
  );
}
