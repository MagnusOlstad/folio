import type {
  ExpandedDirectoryState,
  StoredDraft,
  ViewerDocument,
} from "../domain/types.ts";
import { isUntitledId, storedDraftDocument } from "./workspace.ts";

/**
 * Electron serves the renderer from a random localhost port, so browser
 * localStorage would be scoped to a new origin after every restart. The
 * narrow preload bridge keeps the same API for browsers while moving Folio
 * keys into an app-level store when the desktop shell is present.
 */
export function readStorageItem(key: string): string | null {
  try {
    const desktopValue = window.folio?.getStorage?.(key);
    if (desktopValue !== undefined && desktopValue !== null) return desktopValue;
  } catch {
    /* fall back to browser storage */
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorageItem(key: string, value: string): void {
  try {
    const desktopWrite = window.folio?.setStorage;
    if (desktopWrite) {
      desktopWrite(key, value);
      return;
    }
  } catch {
    /* browser storage remains the fallback */
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* optional persistence */
  }
}

export function removeStorageItem(key: string): void {
  try {
    const desktopRemove = window.folio?.removeStorage;
    if (desktopRemove) {
      desktopRemove(key);
      return;
    }
  } catch {
    /* browser storage remains the fallback */
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* optional persistence */
  }
}

export function loadExpandedDirectoryState(): ExpandedDirectoryState {
  try {
    const stored = readStorageItem("folio:expanded-directories");
    if (stored === null) return { directories: new Set(), restored: false };
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed))
      throw new Error("Invalid expanded directory state");
    return {
      directories: new Set(
        parsed.filter((path): path is string => typeof path === "string"),
      ),
      restored: true,
    };
  } catch {
    return { directories: new Set(), restored: false };
  }
}

/** Restores the existing browser draft cache without changing its on-disk format. */
export function loadLocalDrafts(): ViewerDocument[] {
  if (typeof window === "undefined") return [];
  let storedDrafts: string;
  try {
    storedDrafts = readStorageItem("folio:drafts") || "[]";
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(storedDrafts);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((draft) => {
      if (!draft || typeof draft !== "object") return [];
      const value = draft as Record<string, unknown>;
      if (
        typeof value.id !== "string" ||
        !isUntitledId(value.id) ||
        typeof value.content !== "string"
      )
        return [];
      const createdAt =
        typeof value.createdAt === "string"
          ? value.createdAt
          : new Date().toISOString();
      const updatedAt =
        typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
      return [
        storedDraftDocument({
          id: value.id,
          content: value.content,
          createdAt,
          updatedAt,
        } satisfies StoredDraft),
      ];
    });
  } catch {
    try {
      writeStorageItem(
        `folio:drafts-recovery:${Date.now()}`,
        storedDrafts,
      );
      removeStorageItem("folio:drafts");
    } catch {
      /* storage unavailable */
    }
    return [];
  }
}
