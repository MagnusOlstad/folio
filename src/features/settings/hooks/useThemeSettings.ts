import { useCallback, useLayoutEffect, useState } from "react";
import {
  colorSchemeForTheme,
  isThemeId,
  type ThemeId,
} from "../model/themes.ts";
import { readStorageItem, writeStorageItem } from "../../../lib/storage.ts";

const THEME_STORAGE_KEY = "folio:theme";

export function loadStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "original";
  try {
    const stored = readStorageItem(THEME_STORAGE_KEY);
    return isThemeId(stored) ? stored : "original";
  } catch {
    return "original";
  }
}

function persistTheme(themeId: ThemeId) {
  try {
    writeStorageItem(THEME_STORAGE_KEY, themeId);
  } catch {
    /* Theme persistence is optional when browser storage is unavailable. */
  }
}

function applyTheme(themeId: ThemeId) {
  document.documentElement.dataset.theme = themeId;
  document.documentElement.style.colorScheme = colorSchemeForTheme(themeId);
}

export function useThemeSettings() {
  const [themeId, setThemeId] = useState<ThemeId>(loadStoredTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useLayoutEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  const selectTheme = useCallback((nextThemeId: ThemeId) => {
    setThemeId(nextThemeId);
    persistTheme(nextThemeId);
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return {
    themeId,
    settingsOpen,
    selectTheme,
    openSettings,
    closeSettings,
  };
}
