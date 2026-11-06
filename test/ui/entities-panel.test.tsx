import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.unstubAllGlobals());
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

    await screen.findByRole("checkbox", { name: "Include Acme in scope" });
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

  it("restores dismissed mentions from the refreshed dismissed group", async () => {
    let dismissed = false;
    let revision = 4;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("/settings")) body = { enabled: true, modelId: "gliner25multi" };
      else if (url.includes("/corrections/latest")) body = { revision, undoToken: null };
      else if (url.includes("/jobs")) body = { items: [], nextCursor: null, mode: "running" };
      else if (url.includes("/related")) body = { items: [], nextCursor: null };
      else if (url.includes("/mentions?")) body = { items: [{ ...mention, status: dismissed ? "dismissed" : "active" }], staleCount: 0, freshness: "current", coverage: null };
      else if (url.includes("/api/entities?") || url.endsWith("/api/entities")) body = { items: [], nextCursor: null, coverage: { eligible: 1, processed: 1, pending: 0, stale: 0, failed: 0 } };
      else if (url.includes("/corrections")) {
        const payload = JSON.parse(String(init?.body));
        dismissed = payload.command.type === "dismiss";
        revision += 1;
        body = { revision, indexRevision: revision };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EntitiesPanel bundleId="bundle-a" note={{ id: "note-a", title: "Acme launch", content: "Acme" }} draft={undefined} onReveal={vi.fn()} onOpenNote={vi.fn()} onCreateNote={vi.fn(async () => null)} onOpenSettings={vi.fn()} scope={{ bundleId: "bundle-a", entityIds: [], entities: [], toggleEntity: vi.fn(), clear: vi.fn() }} />);

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    const dismissedGroup = await screen.findByRole("region", { name: "Dismissed mentions" });
    expect(within(dismissedGroup).getByText("Acme")).toBeVisible();
    fireEvent.click(within(dismissedGroup).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Dismissed mentions" })).toBeNull());
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });

  it("refreshes entity detail after corrections and resets edit state when identity changes", async () => {
    let firstDetail = true;
    const records = [
      { id: "entity-a", label: "Acme stale catalog value", type: "organization" as const, aliases: [] as string[], mentionCount: 1, noteCount: 1, createdAt: "", updatedAt: "1" },
      { id: "entity-b", label: "Atlas", type: "project" as const, aliases: [] as string[], mentionCount: 1, noteCount: 1, createdAt: "", updatedAt: "1" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("/settings")) body = { enabled: true, modelId: "gliner25multi" };
      else if (url.includes("/corrections/latest")) body = { revision: 1, undoToken: null };
      else if (url.includes("/jobs")) body = { items: [], nextCursor: null, mode: "running" };
      else if (url.includes("/related")) body = { items: [], nextCursor: null };
      else if (url.includes("/mentions?")) body = { items: [], staleCount: 0, freshness: "current", coverage: null };
      else if (url.includes("/corrections")) {
        const { command } = JSON.parse(String(init?.body));
        const record = records.find((item) => item.id === command.entityId);
        if (record && command.type === "add-alias") record.aliases.push(command.alias);
        if (record && command.type === "rename") { record.label = command.label; record.updatedAt = String(Date.now()); }
        body = { revision: 2, indexRevision: 2 };
      } else if (url.includes("/api/entities?") || url.endsWith("/api/entities")) body = { items: records, nextCursor: null, coverage: { eligible: 1, processed: 1, pending: 0, stale: 0, failed: 0 } };
      else if (url.includes("/api/entities/")) {
        const record = records.find((item) => url.endsWith(item.id));
        if (record && firstDetail) { record.label = "Acme canonical detail"; firstDetail = false; }
        body = { ...record, bundleId: "bundle-a", revision: 1, noteIds: ["note-a"] };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EntitiesPanel bundleId="bundle-a" note={null} draft={undefined} onReveal={vi.fn()} onOpenNote={vi.fn()} onCreateNote={vi.fn(async () => null)} onOpenSettings={vi.fn()} scope={{ bundleId: "bundle-a", entityIds: [], entities: [], toggleEntity: vi.fn(), clear: vi.fn() }} />);

    fireEvent.click(await screen.findByRole("button", { name: "Acme stale catalog value" }));
    const detail = await screen.findByRole("generic", { name: "Acme canonical detail details" });
    fireEvent.change(within(detail).getByLabelText("Add alias"), { target: { value: "Acme Corp" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add alias" }));
    await waitFor(() => expect(within(screen.getByRole("generic", { name: "Acme canonical detail details" })).getByText("Acme Corp")).toBeVisible());
    fireEvent.change(within(screen.getByRole("generic", { name: "Acme canonical detail details" })).getByLabelText("Rename"), { target: { value: "Acme Incorporated" } });
    fireEvent.click(within(screen.getByRole("generic", { name: "Acme canonical detail details" })).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("generic", { name: "Acme Incorporated details" })).toBeVisible());
    fireEvent.click(within(screen.getByRole("generic", { name: "Acme Incorporated details" })).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Atlas" }));
    const atlasDetail = await screen.findByRole("generic", { name: "Atlas details" });
    expect(within(atlasDetail).getByLabelText("Rename")).toHaveValue("Atlas");
  });

  it("drops an in-flight entity page when the search filter changes", async () => {
    let resolveOldPage: ((response: Response) => void) | undefined;
    const delayedOldPage = new Promise<Response>((resolve) => { resolveOldPage = resolve; });
    const first: EntityPageItem = { id: "entity-first", label: "First result", type: "organization", aliases: [], mentionCount: 1, noteCount: 1, createdAt: "", updatedAt: "" };
    const filtered: EntityPageItem = { id: "entity-filtered", label: "Filtered result", type: "organization", aliases: [], mentionCount: 1, noteCount: 1, createdAt: "", updatedAt: "" };
    const stale: EntityPageItem = { id: "entity-stale", label: "Stale page result", type: "organization", aliases: [], mentionCount: 1, noteCount: 1, createdAt: "", updatedAt: "" };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/settings")) return Promise.resolve(json({ enabled: true, modelId: "gliner25multi" }));
      if (url.includes("/corrections/latest")) return Promise.resolve(json({ revision: 1, undoToken: null }));
      if (url.includes("/jobs")) return Promise.resolve(json({ items: [], nextCursor: null, mode: "running" }));
      if (url.includes("/related")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (url.includes("/mentions?")) return Promise.resolve(json({ items: [], staleCount: 0, freshness: "current", coverage: null }));
      if (url.includes("cursor=old-page")) return delayedOldPage;
      if (url.includes("q=Filtered")) return Promise.resolve(json({ items: [filtered], nextCursor: null, coverage: null }));
      return Promise.resolve(json({ items: [first], nextCursor: "old-page", coverage: null }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EntitiesPanel bundleId="bundle-a" note={null} draft={undefined} onReveal={vi.fn()} onOpenNote={vi.fn()} onCreateNote={vi.fn(async () => null)} onOpenSettings={vi.fn()} scope={{ bundleId: "bundle-a", entityIds: [], entities: [], toggleEntity: vi.fn(), clear: vi.fn() }} />);

    expect(await screen.findByRole("button", { name: "First result" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more entities" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cursor=old-page"), expect.anything()));
    fireEvent.change(screen.getByRole("textbox", { name: "Search entities" }), { target: { value: "Filtered" } });
    expect(await screen.findByRole("button", { name: "Filtered result" })).toBeVisible();
    resolveOldPage?.(json({ items: [stale], nextCursor: null, coverage: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stale page result" })).not.toBeInTheDocument());
  });
});

type EntityPageItem = { id: string; label: string; type: "organization"; aliases: string[]; mentionCount: number; noteCount: number; createdAt: string; updatedAt: string };
function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
