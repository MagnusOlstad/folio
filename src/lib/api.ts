/** Keeps the server's response and error semantics in one place for every feature. */
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { "content-type": "application/json", ...options?.headers },
    });
  } catch {
    throw new Error("The local Folio service is not ready yet.");
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
            ? "The local Folio service is not ready yet."
            : `Request failed (${response.status}).`,
      );
    }
  }
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result
        ? String(result.error)
        : [502, 503, 504].includes(response.status)
          ? "The local Folio service is not ready yet."
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
