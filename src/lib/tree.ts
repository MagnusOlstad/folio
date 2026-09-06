import type { BundleFile, TreeDirectory } from "../domain/types.ts";

export function buildFileTree(files: BundleFile[]): TreeDirectory {
  type MutableTree = Omit<TreeDirectory, "directories"> & {
    directories: Map<string, MutableTree>;
  };
  const root: MutableTree = {
    name: "Bundle",
    path: "/",
    directories: new Map(),
    files: [],
  };
  for (const file of files) {
    const parts = file.id.split("/").filter(Boolean);
    parts.pop();
    let current = root;
    let path = "";
    for (const part of parts) {
      path += `/${part}`;
      if (!current.directories.has(part))
        current.directories.set(part, {
          name: part,
          path,
          directories: new Map(),
          files: [],
        });
      current = current.directories.get(part)!;
    }
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
