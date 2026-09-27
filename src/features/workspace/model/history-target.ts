import type { ViewerDocument } from "../../../domain/types.ts";
import { isUntitledId } from "../../../lib/workspace.ts";

export type HistoryTarget = { groupId: string; documentId: string };

export function resolveHistoryTarget(
  current: HistoryTarget | null,
  activeGroupId: string,
  activeDocumentId: string | null | undefined,
  activeDocument: ViewerDocument | null,
  loading: boolean,
): HistoryTarget | null {
  if (!current || !activeDocumentId) return null;
  if (!activeDocument) return loading ? { groupId: activeGroupId, documentId: activeDocumentId } : null;
  if (isUntitledId(activeDocumentId) || !activeDocument.deletable) return null;
  if (current.groupId === activeGroupId && current.documentId === activeDocumentId) return current;
  return { groupId: activeGroupId, documentId: activeDocumentId };
}
