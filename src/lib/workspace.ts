import type {
  BundleFile,
  MarkdownNode,
  StoredDraft,
  ViewerDocument,
} from "../domain/types.ts";

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}
export function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}
export function isUntitledId(id: string) {
  return id.startsWith("untitled:");
}
export function filedDraftContent(value: string) {
  const firstLineBreak = value.indexOf("\n");
  return firstLineBreak === -1 ? value : value.slice(firstLineBreak + 1);
}
export function mergeRemoteAppend(
  baseContent: string,
  localContent: string,
  remoteContent: string,
) {
  const base = baseContent.replace(/\r\n/g, "\n").trimEnd();
  const remote = remoteContent.replace(/\r\n/g, "\n").trimEnd();
  const local = localContent.replace(/\r\n/g, "\n").trimEnd();
  if (remote === base || !remote.startsWith(base) || !/^\n/.test(remote.slice(base.length))) return localContent;
  const remoteTail = remote.slice(base.length);
  if (!remoteTail.trim()) return localContent;
  const normalizeCheckboxState = (value: string) => value.replace(/\[[ xX]\]/g, "[ ]");
  const normalizedRemoteTail = normalizeCheckboxState(remoteTail);
  const normalizedLocal = normalizeCheckboxState(local);
  if (normalizedLocal.includes(normalizedRemoteTail.trim())) return localContent;
  if (local.startsWith(base)) {
    const localTail = local.slice(base.length);
    const normalizedLocalTail = normalizeCheckboxState(localTail);
    if (normalizedRemoteTail === normalizedLocalTail) return localContent;
    if (normalizedRemoteTail.startsWith(normalizedLocalTail)) return `${local}${remoteTail.slice(localTail.length)}`;
    if (normalizedLocalTail.startsWith(normalizedRemoteTail)) return localContent;
    let sharedLength = 0;
    while (sharedLength < remoteTail.length && remoteTail[sharedLength] === localTail[sharedLength]) sharedLength += 1;
    const sharedBoundary = remoteTail.lastIndexOf("\n", sharedLength - 1) + 1;
    const shared = remoteTail.slice(0, sharedBoundary);
    const localOnly = localTail.slice(sharedBoundary).trim();
    const remoteOnly = remoteTail.slice(sharedBoundary).trim();
    const mergedTail = [shared.trimEnd(), localOnly, remoteOnly].filter(Boolean).join("\n");
    return `${base}\n${mergedTail}`;
  }
  const appended = remoteTail.trim();
  if (local.includes(appended)) return localContent;
  return `${local}\n\n${appended}`;
}
export function expandedPathsForFiles(files: BundleFile[]) {
  const expanded = new Set<string>(["/"]);
  for (const file of files) {
    let currentPath = "";
    for (const segment of file.directory.split("/").filter(Boolean)) {
      currentPath += `/${segment}`;
      expanded.add(currentPath);
    }
  }
  return expanded;
}
export function toggleTaskAtLine(
  content: string,
  lineNumber: number,
  checked: boolean,
) {
  const lines = content.split("\n");
  const lineIndex = lineNumber - 1;
  const taskMarker = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[[ xX]\]/;
  if (
    lineIndex < 0 ||
    lineIndex >= lines.length ||
    !taskMarker.test(lines[lineIndex])
  )
    return null;
  lines[lineIndex] = lines[lineIndex].replace(
    taskMarker,
    `$1[${checked ? "x" : " "}]`,
  );
  return lines.join("\n");
}
export function sourcePosition(node?: MarkdownNode) {
  return {
    "data-source-line": node?.position?.start.line,
    "data-source-end-line": node?.position?.end.line,
  };
}
export function storedDraftDocument(draft: StoredDraft): ViewerDocument {
  return {
    id: draft.id,
    title: "Untitled",
    type: "Local draft",
    description: "",
    tags: [],
    createdAt: draft.createdAt,
    content: draft.content,
    deletable: true,
    movable: false,
    status: "draft",
    staleAfter: null,
    stale: false,
    filedBy: null,
    filedAt: null,
    links: [],
    backlinks: [],
    suggestions: [],
    updatedAt: draft.updatedAt,
  };
}
