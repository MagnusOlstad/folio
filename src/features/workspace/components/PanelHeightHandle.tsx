import type { KeyboardEvent, PointerEvent } from "react";

type PanelHeightHandleProps = {
  label: string;
  value: number | null;
  minHeight: number;
  maxHeight: number;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

export function PanelHeightHandle({ label, value, minHeight, maxHeight, onPointerDown, onPointerMove, onPointerUp, onKeyDown }: PanelHeightHandleProps) {
  return (
    <div
      className="panel-height-handle"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={minHeight}
      aria-valuemax={maxHeight}
      aria-valuenow={value ?? undefined}
      title={`Resize ${label.replace(/^Resize /, "").toLowerCase()}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
