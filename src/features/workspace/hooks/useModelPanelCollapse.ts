import { useState } from "react";

const COLLAPSE_STORAGE_KEY = "folio:model-panel-collapsed";

export function useModelPanelCollapse() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // The panel remains usable when storage is unavailable.
    }
  }

  return { collapsed, toggleCollapsed };
}
