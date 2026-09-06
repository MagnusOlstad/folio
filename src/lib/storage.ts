import type {
  ExpandedDirectoryState,
  StoredDraft,
  ViewerDocument,
} from "../domain/types.ts";
import { isUntitledId, storedDraftDocument } from "./workspace.ts";

export function loadExpandedDirectoryState(): ExpandedDirectoryState {
  try {
    const stored = window.localStorage.getItem("folio:expanded-directories");
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
    storedDrafts = window.localStorage.getItem("folio:drafts") || "[]";
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
      window.localStorage.setItem(
        `folio:drafts-recovery:${Date.now()}`,
        storedDrafts,
      );
      window.localStorage.removeItem("folio:drafts");
    } catch {
      /* storage unavailable */
    }
    return [];
  }
}
