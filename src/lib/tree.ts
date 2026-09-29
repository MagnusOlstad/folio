import type { BundleDirectory, BundleFile, TreeDirectory } from "../domain/types.ts";
import { isInternalBundlePath } from "./paths.ts";

export function buildFileTree(
  files: BundleFile[],
  directories: BundleDirectory[] = [],
): TreeDirectory {
  type MutableTree = Omit<TreeDirectory, "directories"> & {
    directories: Map<string, MutableTree>;
  };
  const root: MutableTree = {
    name: "Bundle",
    path: "/",
    directories: new Map(),
    files: [],
  };
  function ensureDirectory(directoryPath: string) {
    const parts = directoryPath.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (const part of parts) {
      currentPath += `/${part}`;
      if (!current.directories.has(part))
        current.directories.set(part, {
          name: part,
          path: currentPath,
          directories: new Map(),
          files: [],
        });
      current = current.directories.get(part)!;
    }
    return current;
  }
  for (const directory of directories) {
    if (directory.path === "/" || isInternalBundlePath(directory.path)) continue;
    ensureDirectory(directory.path);
  }
  for (const file of files) {
    if (isInternalBundlePath(file.id)) continue;
    const current = ensureDirectory(file.id.split("/").slice(0, -1).join("/"));
    current.files.push(file);
  }
  const finalize = (directory: MutableTree): TreeDirectory => ({
    name: directory.name,
    path: directory.path,
    directories: [...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(finalize),
    files: directory.files.sort(
      (left, right) =>
        left.title.localeCompare(right.title) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.name.localeCompare(right.name),
    ),
  });
  return finalize(root);
}
