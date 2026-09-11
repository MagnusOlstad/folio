import type { SidebarMode, TabGroup } from "../../../domain/types.ts";
import { readStorageItem } from "../../../lib/storage.ts";

export const WORKSPACE_STATE_STORAGE_KEY = "folio:workspace-state";
export const WORKSPACE_STATE_VERSION = 1;

export type WorkspaceSessionState = {
  version: 1;
  groups: TabGroup[];
  activeGroupId: string;
  sidebarMode: SidebarMode;
  explorerScrollTop: number;
  documentScrollTops: Record<string, number>;
};

const sidebarModes = new Set<SidebarMode>(["explore", "search", "ask"]);
const workspaceGroupIds = new Set(["primary", "secondary"]);
export const MAX_TABS_PER_GROUP = 100;
export const MAX_DOCUMENT_SCROLL_ENTRIES = 200;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}

function parseGroup(value: unknown, seenTabs: Set<string>): TabGroup | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !workspaceGroupIds.has(candidate.id) ||
    !Array.isArray(candidate.tabs)
  )
    return null;
  const tabs = Array.from(
    new Set(
      candidate.tabs
        .filter((tab): tab is string => validId(tab) && !seenTabs.has(tab))
        .slice(0, MAX_TABS_PER_GROUP),
    ),
  );
  tabs.forEach((tab) => seenTabs.add(tab));
  const activeId = validId(candidate.activeId) && tabs.includes(candidate.activeId)
    ? candidate.activeId
    : null;
  const previewId = validId(candidate.previewId) && tabs.includes(candidate.previewId)
    ? candidate.previewId
    : null;
  return { id: candidate.id, tabs, activeId, previewId };
}

export function parseWorkspaceSessionState(value: unknown): WorkspaceSessionState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== WORKSPACE_STATE_VERSION || !Array.isArray(candidate.groups)) return null;
  const seenTabs = new Set<string>();
  const seenGroupIds = new Set<string>();
  const groups: TabGroup[] = [];
  for (const candidateGroup of candidate.groups) {
    if (groups.length >= 2 || !candidateGroup || typeof candidateGroup !== "object")
      continue;
    const groupId = (candidateGroup as Record<string, unknown>).id;
    if (typeof groupId !== "string" || seenGroupIds.has(groupId)) continue;
    const group = parseGroup(candidateGroup, seenTabs);
    if (!group) continue;
    seenGroupIds.add(group.id);
    groups.push(group);
  }
  if (!groups.length) return null;
  const activeGroupId = validId(candidate.activeGroupId) && groups.some((group) => group.id === candidate.activeGroupId)
    ? candidate.activeGroupId
    : groups[0].id;
  const sidebarMode = sidebarModes.has(candidate.sidebarMode as SidebarMode)
    ? (candidate.sidebarMode as SidebarMode)
    : "explore";
  const explorerScrollTop = typeof candidate.explorerScrollTop === "number" && Number.isFinite(candidate.explorerScrollTop) && candidate.explorerScrollTop >= 0
    ? candidate.explorerScrollTop
    : 0;
  const documentScrollTops: Record<string, number> = {};
  if (candidate.documentScrollTops && typeof candidate.documentScrollTops === "object") {
    for (const [id, top] of Object.entries(candidate.documentScrollTops).slice(-MAX_DOCUMENT_SCROLL_ENTRIES)) {
      if (validId(id) && typeof top === "number" && Number.isFinite(top) && top >= 0)
        documentScrollTops[id] = top;
    }
  }
  return { version: 1, groups, activeGroupId, sidebarMode, explorerScrollTop, documentScrollTops };
}

export function pruneDocumentScrollTops(
  entries: Record<string, number>,
  validIds?: ReadonlySet<string>,
): Record<string, number> {
  const candidates = Object.entries(entries).filter(
    ([id, top]) => validId(id) && Number.isFinite(top) && top >= 0 && (!validIds || validIds.has(id)),
  );
  return Object.fromEntries(candidates.slice(-MAX_DOCUMENT_SCROLL_ENTRIES));
}

export function reconcileWorkspaceSessionState(
  state: WorkspaceSessionState,
  validIds: ReadonlySet<string>,
): Pick<WorkspaceSessionState, "groups" | "activeGroupId"> {
  const groups = state.groups.map((group) => {
    const tabs = group.tabs.filter((id) => validIds.has(id));
    return {
      ...group,
      tabs,
      activeId: group.activeId && tabs.includes(group.activeId) ? group.activeId : tabs[0] ?? null,
      previewId: group.previewId && tabs.includes(group.previewId) ? group.previewId : null,
    };
  });
  const nextGroups = groups.length
    ? groups
    : [{ id: "primary", tabs: [], activeId: null, previewId: null }];
  const activeGroupId = nextGroups.some((group) => group.id === state.activeGroupId)
    ? state.activeGroupId
    : nextGroups[0].id;
  return { groups: nextGroups, activeGroupId };
}

export function loadWorkspaceSessionState(): WorkspaceSessionState | null {
  try {
    const stored = readStorageItem(WORKSPACE_STATE_STORAGE_KEY);
    if (!stored) return null;
    return parseWorkspaceSessionState(JSON.parse(stored));
  } catch {
    return null;
  }
}
