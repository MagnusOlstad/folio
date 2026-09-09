import type { BundleFile } from "../../../domain/types.ts";
import { isInternalBundlePath } from "../../../lib/paths.ts";

export type DirectorySuggestion = {
  directory: string;
  segment: string;
};

export type DirectorySuggestionContext = {
  segmentStart: number;
  segmentEnd: number;
  suggestions: DirectorySuggestion[];
};

/** Returns every existing directory, including directories implied by nested files. */
export function bundleDirectories(files: BundleFile[]) {
  const directories = new Set(["/"]);
  for (const file of files) {
    if (isInternalBundlePath(file.id)) continue;
    let path = "";
    for (const segment of file.directory.split("/").filter(Boolean)) {
      path += `/${segment}`;
      directories.add(path);
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

function parentDirectory(directory: string) {
  const parent = directory.slice(0, directory.lastIndexOf("/"));
  return parent || "/";
}

export function directorySuggestionContext(
  value: string,
  caretPosition: number,
  directories: string[],
): DirectorySuggestionContext {
  const caret = Math.max(0, Math.min(caretPosition, value.length));
  const segmentStart = value.lastIndexOf("/", Math.max(0, caret - 1)) + 1;
  const followingSlash = value.indexOf("/", caret);
  const segmentEnd = followingSlash === -1 ? value.length : followingSlash;
  const query = value.slice(segmentStart, segmentEnd).toLocaleLowerCase();
  const prefixParts = value.slice(0, segmentStart).split("/").filter(Boolean);
  const prefix = prefixParts.length ? `/${prefixParts.join("/")}` : "/";
  const suggestions = directories
    .filter((directory) => parentDirectory(directory) === prefix)
    .map((directory) => ({
      directory,
      segment: directory.slice(directory.lastIndexOf("/") + 1),
    }))
    .filter(({ segment }) => segment.toLocaleLowerCase().startsWith(query))
    .sort((left, right) => left.segment.localeCompare(right.segment));
  return { segmentStart, segmentEnd, suggestions };
}

export function applyDirectorySuggestion(
  value: string,
  context: DirectorySuggestionContext,
  suggestion: DirectorySuggestion,
) {
  return `${value.slice(0, context.segmentStart)}${suggestion.segment}${value.slice(context.segmentEnd)}`;
}
