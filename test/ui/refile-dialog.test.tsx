import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefileEntry } from "../../src/features/workspace/model/refile.ts";
import { refileRequestFields } from "../../src/features/workspace/model/refile.ts";
import { useNoteRefile } from "../../src/features/workspace/hooks/useNoteRefile.ts";
import { RefileDialog } from "../../src/features/workspace/components/RefileDialog.tsx";

const entry: RefileEntry = {
  documentId: "/notes/original.md",
  status: "ready",
  proposal: {
    id: "/notes/original.md",
    hash: "a".repeat(64),
    proposal: {
      directory: "/ideas",
      filename: "new-idea.md",
      title: "New idea",
      description: "Suggested description.",
      tags: ["ideas"],
    },
  },
  fields: {
    directory: "/ideas",
    filename: "new-idea.md",
    title: "New idea",
    description: "Suggested description.",
    tags: ["ideas"],
  },
  error: null,
};

describe("refile review", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shares filing fields, suggestions, Enter acceptance, and Escape discard", () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(
      <RefileDialog
        entry={entry}
        directories={["/", "/ideas", "/ideas/writing", "/notes"]}
        onStart={vi.fn()}
        onChange={onChange}
        onAccept={onAccept}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Refile note" });
    expect(dialog).not.toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("combobox", { name: "Path" })).toHaveValue("/ideas");
    fireEvent.change(screen.getByRole("combobox", { name: "Path" }), { target: { value: "/ideas/writing" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      directory: "/ideas/writing",
      filename: "new-idea.md",
    }));
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });
    expect(onAccept).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses Enter on a path suggestion before it can accept the refile", () => {
    const onAccept = vi.fn();
    const onChange = vi.fn();
    render(
      <RefileDialog
        entry={{ ...entry, fields: { ...entry.fields!, directory: "/ide" } }}
        directories={["/", "/ideas", "/ideas/writing"]}
        onStart={vi.fn()}
        onChange={onChange}
        onAccept={onAccept}
        onClose={vi.fn()}
      />,
    );

    const path = screen.getByRole("combobox", { name: "Path" });
    path.focus();
    path.setSelectionRange(3, 3);
    fireEvent.select(path);
    expect(screen.getByRole("option", { name: "/ideas" })).toBeInTheDocument();
    fireEvent.keyDown(path, { key: "ArrowDown" });
    fireEvent.keyDown(path, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ directory: "/ideas" }));
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("does not accept when Enter is pressed in another part of the workspace", () => {
    const onAccept = vi.fn();
    render(
      <>
        <RefileDialog entry={entry} directories={["/", "/ideas"]} onStart={vi.fn()} onChange={vi.fn()} onAccept={onAccept} onClose={vi.fn()} />
        <input aria-label="Another note" />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("Another note"), { key: "Enter" });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("submits the proposed filename with its separate directory", () => {
    expect(refileRequestFields({
      directory: "/archive/ideas/",
      filename: "final.md",
      title: "Final title",
      description: "Updated.",
      tags: ["ready"],
    })).toEqual({
      directory: "/archive/ideas",
      filename: "final.md",
      title: "Final title",
      description: "Updated.",
      tags: ["ready"],
    });
  });

  it("retains a proposal while another file is active and clears cancelled work", async () => {
    let resolveProposal: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveProposal = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const prepare = vi.fn().mockResolvedValue(true);
    const onComplete = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeDocumentId }: { activeDocumentId: string }) => {
        const refile = useNoteRefile({ bundleId: "bundle-1", prepare, onComplete });
        return { ...refile, activeEntry: refile.entries[activeDocumentId] };
      },
      { initialProps: { activeDocumentId: entry.documentId } },
    );

    await act(async () => { void result.current.start(entry.documentId); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    rerender({ activeDocumentId: "/notes/other.md" });
    await act(async () => {
      resolveProposal?.(new Response(JSON.stringify(entry.proposal), { status: 200 }));
    });
    expect(result.current.activeEntry).toBeUndefined();
    expect(result.current.entries[entry.documentId]?.fields?.filename).toBe("new-idea.md");

    await act(async () => { result.current.dismiss(entry.documentId); });
    rerender({ activeDocumentId: entry.documentId });
    expect(result.current.activeEntry).toBeUndefined();
  });
});
