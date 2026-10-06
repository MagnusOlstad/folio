import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

type DragState = { pointerId: number; startY: number; startHeight: number };

const MIN_PANEL_HEIGHT = 76;
const MAX_VIEWPORT_RATIO = 0.5;

export type PanelHeightResize = {
  height: number | null;
  minHeight: number;
  maxHeight: number;
  panelRef: RefObject<HTMLElement | null>;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

/** Resizes a pane upward from its top edge while preserving its chosen height when collapsed. */
export function usePanelHeightResize(collapsed: boolean): PanelHeightResize {
  const [height, setHeight] = useState<number | null>(null);
  const [maxHeight, setMaxHeight] = useState(340);
  const panelRef = useRef<HTMLElement>(null);
  const dragState = useRef<DragState | null>(null);

  const limits = useCallback(() => {
    const panel = panelRef.current;
    const availableHeight = panel?.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
    const reserveHeight = panel?.classList.contains("right-pane-status") ? 236 : 116;
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(
      Math.round(window.innerHeight * MAX_VIEWPORT_RATIO),
      Math.round(availableHeight - reserveHeight),
    ));
    return { min: MIN_PANEL_HEIGHT, max: maxHeight };
  }, []);

  const resizeTo = useCallback((value: number) => {
    const { min, max } = limits();
    setHeight(Math.round(Math.max(min, Math.min(max, value))));
  }, [limits]);

  useEffect(() => {
    const updateBounds = () => {
      const { max } = limits();
      setMaxHeight(max);
      setHeight((current) => current === null ? null : Math.min(max, current));
    };
    updateBounds();
    const parent = panelRef.current?.parentElement;
    const observer = parent && typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateBounds) : null;
    if (parent) observer?.observe(parent);
    window.addEventListener("resize", updateBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateBounds);
      dragState.current = null;
    };
  }, [collapsed, limits]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    const panelHeight = height ?? panel.getBoundingClientRect().height;
    dragState.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: panelHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [height]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    resizeTo(drag.startHeight + drag.startY - event.clientY);
  }, [resizeTo]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const currentHeight = height ?? panelRef.current?.getBoundingClientRect().height ?? MIN_PANEL_HEIGHT;
      resizeTo(currentHeight + (event.key === "ArrowUp" ? 16 : -16));
    } else if (event.key === "Home") {
      event.preventDefault();
      resizeTo(limits().min);
    } else if (event.key === "End") {
      event.preventDefault();
      resizeTo(limits().max);
    }
  }, [height, limits, resizeTo]);

  return {
    height: collapsed ? null : height,
    minHeight: MIN_PANEL_HEIGHT,
    maxHeight,
    panelRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
  };
}
