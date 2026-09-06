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
export function hasInstalledModel(model: string, installed: string[]) {
  const canonicalName = model.includes(":") ? model : `${model}:latest`;
  return installed.includes(model) || installed.includes(canonicalName);
}
export function isUntitledId(id: string) {
  return id.startsWith("untitled:");
}
export function filedDraftContent(value: string) {
  const firstLineBreak = value.indexOf("\n");
  return firstLineBreak === -1 ? value : value.slice(firstLineBreak + 1);
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
