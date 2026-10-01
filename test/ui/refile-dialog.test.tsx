import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefileResult, ViewerDocument } from "../../src/domain/types.ts";
import { RefileDialog } from "../../src/features/workspace/components/RefileDialog.tsx";

const note: ViewerDocument = {
  id: "/notes/original.md", title: "Original", type: "Note", description: "Before.", tags: [],
  createdAt: "2026-10-01T00:00:00.000Z", content: "Latest edits stay intact.", deletable: true, movable: true,
  status: "draft", staleAfter: null, stale: false, filedBy: "human:local", filedAt: "2026-10-01T00:00:00.000Z",
  links: [], backlinks: [], suggestions: [],
};

describe("refile dialog", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("accepts the untouched suggested path and metadata", async () => {
    const proposal = {
      id: note.id,
      hash: "a".repeat(64),
      proposal: { directory: "/ideas", filename: "new-idea.md", title: "New idea", description: "Suggested description.", tags: ["ideas"] },
    };
    const result: RefileResult = {
      oldId: note.id,
      newId: "/ideas/new-idea.md",
      warning: null,
      note: { ...note, id: "/ideas/new-idea.md", title: "New idea", rawId: null, classifiedByModel: false, relatedIds: [] },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(proposal), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onComplete = vi.fn();
    render(<RefileDialog document={note} onClose={vi.fn()} onComplete={onComplete} />);

    await screen.findByDisplayValue("/ideas/new-idea.md");
    fireEvent.click(screen.getByRole("button", { name: "Accept and refile" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(result));
    const request = fetchMock.mock.calls[1];
    expect(String(request[0])).toBe("/api/file/refile");
    const body = JSON.parse(String(request[1]?.body));
    expect(body.fields).toEqual({
      directory: "/ideas", filename: "new-idea.md", title: "New idea", description: "Suggested description.", tags: ["ideas"],
    });
  });

  it("keeps focus while parent callbacks change identity", async () => {
    const proposal = {
      id: note.id,
      hash: "b".repeat(64),
      proposal: { directory: "/ideas", filename: "new-idea.md", title: "New idea", description: "Suggested description.", tags: ["ideas"] },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(proposal), { status: 200 })));
    const view = render(<RefileDialog document={note} onClose={() => {}} onComplete={() => {}} />);
    const title = await screen.findByDisplayValue("New idea");
    title.focus();

    view.rerender(<RefileDialog document={note} onClose={() => {}} onComplete={() => {}} />);

    expect(document.activeElement).toBe(title);
  });
});
