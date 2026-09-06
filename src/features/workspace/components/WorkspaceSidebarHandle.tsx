import type { PointerEvent } from "react";

type WorkspaceSidebarHandleProps = {
  width: number | null;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onResize: (clientX: number, handle: HTMLElement) => void;
  onPointerEnd: (event: PointerEvent<HTMLElement>) => void;
  onReset: () => void;
};

export function WorkspaceSidebarHandle({
  width,
  onPointerDown,
  onResize,
  onPointerEnd,
  onReset,
}: WorkspaceSidebarHandleProps) {
  return (
    <div
      className="horizontal-resize-handle sidebar-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="Resize sidebar"
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
        const currentWidth =
          width ||
          event.currentTarget.previousElementSibling?.getBoundingClientRect()
            .width ||
          310;
        const workspaceLeft =
          event.currentTarget.parentElement?.getBoundingClientRect().left || 0;
        onResize(
          workspaceLeft +
            currentWidth +
            (event.key === "ArrowLeft" ? -16 : 16),
          event.currentTarget,
        );
      }}
    />
  );
}
