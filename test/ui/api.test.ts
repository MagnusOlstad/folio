import { afterEach, describe, expect, it, vi } from "vitest";

import { api, apiForBundle, getActiveBundleRevision, setActiveBundleId } from "../../src/lib/api.ts";

describe("API client error contract", () => {
  afterEach(() => { vi.unstubAllGlobals(); setActiveBundleId(null); });

  it("pins explicit bundle requests and keeps legacy requests free of the active bundle", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);
    setActiveBundleId("bundle-b");
    await apiForBundle("bundle-a", "/api/files", { headers: new Headers({ authorization: "Bearer test" }) });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "x-folio-bundle": "bundle-a", "x-folio-bundle-id": "bundle-a", authorization: "Bearer test" });
    await apiForBundle(null, "/api/files");
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ "content-type": "application/json" });
  });

  it("changes the scope revision when switching away and back to the same bundle", () => {
    setActiveBundleId("bundle-a");
    const revision = getActiveBundleRevision();
    setActiveBundleId("bundle-a");
    expect(getActiveBundleRevision()).toBe(revision);
    setActiveBundleId("bundle-b");
    setActiveBundleId("bundle-a");
    expect(getActiveBundleRevision()).toBe(revision + 2);
  });

  it("adds JSON content type without replacing caller headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api<{ ok: boolean }>("/api/notes", {
        headers: { authorization: "Bearer test" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes", {
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test",
      },
    });
  });

  it("preserves a server-provided error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Cannot move a fixed file." }), {
            status: 409,
          }),
        ),
    );
    await expect(api("/api/files/move")).rejects.toThrow(
      "Cannot move a fixed file.",
    );
  });

  it("maps unavailable services, transport failures, and malformed responses to user-safe messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("upstream unavailable", { status: 503 }),
        ),
    );
    await expect(api("/api/status")).rejects.toThrow(
      "The local FolioNotes service is not ready yet.",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network failed")),
    );
    await expect(api("/api/status")).rejects.toThrow(
      "The local FolioNotes service is not ready yet.",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not JSON", { status: 200 })),
    );
    await expect(api("/api/status")).rejects.toThrow(
      "The server returned an invalid response.",
    );
  });
});
