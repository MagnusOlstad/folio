import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EntityMention } from "../../src/domain/entities.ts";
import { EntitiesPanel } from "../../src/features/workspace/components/EntitiesPanel.tsx";

const mention: EntityMention = {
  id: "mention-1", bundleId: "bundle-a", noteId: "note-a", blockId: null,
  contentHash: "0".repeat(64), projectionVersion: 1, startUtf16: 0, endUtf16: 4,
  rawStartUtf16: 0, rawEndUtf16: 4, displayStartUtf16: 0, displayEndUtf16: 4,
  text: "Acme", type: "organization", extractedType: "organization", score: 0.98, extractionFingerprint: null,
  provenance: {}, entityId: "entity-a", resolution: "resolved", resolutionProvenance: "model", status: "active",
};

describe("EntitiesPanel", () => {
  it("shows current-note evidence and sends a revision-checked related dismissal", async () => {
    const onOpenNote = vi.fn();
    const toggleEntity = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("/settings")) body = { enabled: true, modelId: "gliner25multi" };
      else if (url.includes("/corrections/latest")) body = { revision: 4, undoToken: null };
      else if (url.includes("/jobs")) body = { items: [], nextCursor: null, mode: "running", coverage: { eligible: 1, processed: 1, pending: 0, stale: 0, failed: 0 } };
      else if (url.includes("/related")) body = { items: [{ noteId: "note-b", title: "Atlas planning", noteDate: "2026-11-01", sharedEntityCount: 1, sharedEntities: [{ id: "entity-a", label: "Acme", type: "organization" }] }], nextCursor: null };
      else if (url.includes("/mentions?")) body = { items: [mention], staleCount: 0, freshness: "current", coverage: null };
      else if (url.includes("/api/entities?") || url.endsWith("/api/entities")) body = { items: [{ id: "entity-a", label: "Acme", type: "organization", aliases: [], mentionCount: 1, noteCount: 1, createdAt: "", updatedAt: "" }], nextCursor: null, coverage: { eligible: 1, processed: 1, pending: 0, stale: 0, failed: 0 } };
      else if (url.includes("/corrections")) body = { revision: 5, indexRevision: 5 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EntitiesPanel bundleId="bundle-a" note={{ id: "note-a", title: "Acme launch", content: "Acme" }} draft={undefined} onReveal={vi.fn()} onOpenNote={onOpenNote} onCreateNote={vi.fn(async () => null)} onOpenSettings={vi.fn()} scope={{ bundleId: "bundle-a", entityIds: [], entities: [], toggleEntity, clear: vi.fn() }} />);

    expect((await screen.findAllByRole("button", { name: "Acme" })).length).toBeGreaterThan(0);
    expect(screen.getByText("Atlas planning")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Atlas planning" }));
    expect(onOpenNote).toHaveBeenCalledWith("note-b");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include Acme in scope" }));
    expect(toggleEntity).toHaveBeenCalledWith(expect.objectContaining({ id: "entity-a", label: "Acme" }), true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("includeDismissed=true"))).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/entities/corrections", expect.objectContaining({ method: "POST" })));
    const request = fetchMock.mock.calls.find(([url]) => String(url) === "/api/entities/corrections");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ expectedRevision: 4, command: { type: "dismiss-related", noteId: "note-a", relatedNoteId: "note-b" } });
  });
});
