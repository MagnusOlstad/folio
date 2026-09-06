import type { PointerEvent } from "react";

type WorkspaceSplitHandleProps = {
  splitPosition: number;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onResize: (clientX: number, handle: HTMLElement) => void;
  onPointerEnd: (event: PointerEvent<HTMLElement>) => void;
  onReset: () => void;
};

export function WorkspaceSplitHandle({
  splitPosition,
  onPointerDown,
  onResize,
  onPointerEnd,
  onReset,
}: WorkspaceSplitHandleProps) {
  return (
    <div
      className="horizontal-resize-handle split-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="Resize split notes"
      aria-orientation="vertical"
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(splitPosition)}
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
        const workspace = event.currentTarget.parentElement;
        if (!workspace) return;
        const bounds = workspace.getBoundingClientRect();
        const availableWidth = bounds.width - event.currentTarget.offsetWidth;
        const nextPosition =
          splitPosition + (event.key === "ArrowLeft" ? -2 : 2);
        onResize(
          bounds.left + (availableWidth * nextPosition) / 100,
          event.currentTarget,
        );
      }}
    />
  );
}
