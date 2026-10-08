let activeBundleId: string | null = null;
let activeBundleRevision = 0;

export function setActiveBundleId(bundleId: string | null) {
  if (activeBundleId !== bundleId) activeBundleRevision += 1;
  activeBundleId = bundleId;
}

export function getActiveBundleRevision() {
  return activeBundleRevision;
}

export function getActiveBundleId() {
  return activeBundleId;
}

export async function apiForBundle<T>(bundleId: string | null, url: string, options?: RequestInit): Promise<T> {
  return requestApi<T>(bundleId, url, options, true);
}

/** Keeps the server's response and error semantics in one place for every feature. */
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  return requestApi<T>(activeBundleId, url, options);
}

async function requestApi<T>(bundleId: string | null, url: string, options?: RequestInit, explicitBundle = false): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(options?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (bundleId) {
      if (explicitBundle || !headers.has("x-folio-bundle")) headers.set("x-folio-bundle", bundleId);
      if (explicitBundle || !headers.has("x-folio-bundle-id")) headers.set("x-folio-bundle-id", bundleId);
    }
    response = await fetch(url, {
      ...options,
      headers: Object.fromEntries(headers.entries()),
    });
  } catch {
    throw new Error("The local FolioNotes service is not ready yet.");
  }
  const body = await response.text();
  let result: unknown = null;
  if (body) {
    try {
      result = JSON.parse(body);
    } catch {
      throw new Error(
        response.ok
          ? "The server returned an invalid response."
          : [502, 503, 504].includes(response.status)
            ? "The local FolioNotes service is not ready yet."
            : `Request failed (${response.status}).`,
      );
    }
  }
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result
        ? String(result.error)
        : [502, 503, 504].includes(response.status)
          ? "The local FolioNotes service is not ready yet."
          : `Request failed (${response.status}).`;
    throw new Error(error);
  }
  return result as T;
}

export async function apiWithRetry<T>(
  url: string,
  options?: RequestInit,
  attempts = 8,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api<T>(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1)
        await new Promise((resolve) =>
          window.setTimeout(resolve, Math.min(250 * 2 ** attempt, 1500)),
        );
    }
  }
  throw lastError;
}
