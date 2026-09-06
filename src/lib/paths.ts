export function conceptUrl(id: string) {
  return `/api/concepts?path=${encodeURIComponent(id)}`;
}

export function resolveBundleLink(currentId: string, href?: string) {
  if (!href || href.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(href))
    return null;
  let [filePath] = href.split(/[?#]/);
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    return null;
  }
  if (!filePath.endsWith(".md")) return null;
  const segments = filePath.startsWith("/")
    ? []
    : currentId.split("/").filter(Boolean).slice(0, -1);
  for (const segment of filePath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export function directoryForId(id: string) {
  const directory = id.split("/").slice(0, -1).join("/");
  return directory || "/";
}

export function normalizeDirectoryInput(value: string) {
  const parts = value.trim().replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length ? `/${parts.join("/")}` : "/";
}
