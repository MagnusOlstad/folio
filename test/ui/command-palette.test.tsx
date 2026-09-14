import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../src/domain/types.ts";
import {
  buildPaletteSections,
  filterCommands,
  flattenSections,
  score,
  type PaletteCommand,
} from "../../src/features/workspace/model/command-palette.ts";
import { useCommandPalette } from "../../src/features/workspace/hooks/useCommandPalette.ts";
import { CommandPalette } from "../../src/features/workspace/components/CommandPalette.tsx";

const RECENT_KEY = "folio:palette-recent";

function makeNote(overrides?: Partial<SearchResult>): SearchResult {
  return {
    id: "/notes/searching.md",
    rawId: null,
    title: "Searching notes",
    type: "Note",
    description: "",
    tags: [],
    relatedIds: [],
    createdAt: "2026-09-01T10:00:00.000Z",
    classifiedByModel: false,
    status: "stable",
    staleAfter: null,
    stale: false,
    filedBy: null,
    filedAt: null,
    snippet: "Searching notes with the local service.",
    score: 1,
    ...overrides,
  };
}

describe("palette fuzzy matcher", () => {
  it("rejects non-subsequence queries", () => {
    expect(score("xyz", "Save")).toBeNull();
    expect(score("ets", "notes")).toBeNull();
  });

  it("matches plain subsequences in any case", () => {
    expect(score("sv", "Save")).not.toBeNull();
    expect(score("NOTE", "search notes")).not.toBeNull();
  });

  it("rewards word starts over mid-word matches", () => {
    const wordStart = score("t", "The cat");
    const midWord = score("t", "cat");
    expect(wordStart).toBeGreaterThan(midWord!);
  });

  it("rewards consecutive matches over scattered matches", () => {
    expect(score("abc", "abc")).toBeGreaterThan(score("abc", "a1b2c")!);
  });

  it("penalizes longer gaps", () => {
    expect(score("ab", "a-b")).toBeGreaterThan(score("ab", "a----b")!);
  });

  it("ranks matches by score and ties by registered order", () => {
    const commands: PaletteCommand[] = [
      { id: "anchor", label: "Anchor", run: () => {} },
      { id: "apple", label: "Apple", run: () => {} },
      { id: "burst", label: "Burst On", run: () => {} },
      { id: "stop", label: "Stop", run: () => {} },
    ];
    expect(filterCommands(commands, "a").map((command) => command.id)).toEqual([
      "anchor",
      "apple",
    ]);
    expect(filterCommands(commands, "sto").map((command) => command.id)).toEqual([
      "stop",
      "burst",
    ]);
    expect(filterCommands(commands, "  ")).toEqual([]);
  });
});

describe("palette sectioning", () => {
  const commands: PaletteCommand[] = [
    { id: "new-note", label: "New Note", run: () => {} },
    { id: "save", label: "Save", run: () => {} },
  ];

  it("shows recency first, then all commands, for an empty query", () => {
    const sections = buildPaletteSections({
      commands,
      recentIds: ["save"],
      query: "",
      notes: [],
    });
    expect(sections.map((section) => section.id)).toEqual(["recent", "commands"]);
    expect(sections[0].heading).toBe("Recent");
    expect(sections[0].commands).toEqual([commands[1]]);
    expect(sections[1].heading).toBe("Commands");
    expect(sections[1].commands).toEqual(commands);
  });

  it("shows filtered commands before server notes for a query", () => {
    const noteCommand: PaletteCommand = {
      id: "note:1",
      label: "Obsidian",
      description: "hint",
      run: () => {},
    };
    const sections = buildPaletteSections({
      commands,
      recentIds: [],
      query: "ote",
      notes: [noteCommand],
    });
    expect(sections.map((section) => section.heading)).toEqual([
      "Commands",
      "Notes",
    ]);
    const rows = flattenSections(sections);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ section: "commands", command: commands[0] });
    expect(rows[1]).toEqual({ section: "notes", command: noteCommand });
  });
});

function PaletteHarness({
  commands,
  openNote,
}: {
  commands: PaletteCommand[];
  openNote: (note: SearchResult) => void;
}) {
  const palette = useCommandPalette({ commands, openNote });
  return (
    <div>
      <button type="button" onClick={palette.togglePalette}>
        Toggle palette
      </button>
      {palette.open ? <CommandPalette palette={palette} /> : null}
    </div>
  );
}

describe("command palette component", () => {
  const commands: PaletteCommand[] = [
    { id: "new-note", label: "New Note", run: vi.fn() },
    { id: "save", label: "Save", run: vi.fn() },
    { id: "split-workspace", label: "Split Workspace", run: vi.fn() },
    { id: "search-notes", label: "Search Notes", run: vi.fn() },
  ];

  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  function openPalette() {
    fireEvent.click(screen.getByText("Toggle palette"));
  }

  it("renders recent and command sections with an empty query", () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["save"]));
    render(<PaletteHarness commands={commands} openNote={vi.fn()} />);
    openPalette();

    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("Commands")).toBeInTheDocument();
    const rows = screen.getAllByText("Save");
    expect(rows[0].closest("button")).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByText("New Note")).toBeInTheDocument();
    expect(screen.getByText("Split Workspace")).toBeInTheDocument();
    expect(screen.getByText("↑↓ navigate · ↵ select · esc close")).toBeInTheDocument();
  });

  it("filters commands with a fuzzy query", () => {
    render(<PaletteHarness commands={commands} openNote={vi.fn()} />);
    openPalette();

    fireEvent.change(screen.getByLabelText("Search notes and commands"), {
      target: { value: "sv" },
    });

    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(screen.queryByText("New Note")).not.toBeInTheDocument();
  });

  it("moves selection across sections with arrow keys and executes with Enter", () => {
    const openNote = vi.fn();
    render(<PaletteHarness commands={commands} openNote={openNote} />);
    openPalette();

    const selected = () => document.querySelector('.palette-row[data-selected="true"]');
    expect(selected()?.textContent).toContain("New Note");
    for (let step = 0; step < 2; step += 1)
      fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(selected()?.textContent).toContain("Split Workspace");

    fireEvent.keyDown(document, { key: "Enter" });
    expect(commands[2].run).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("executes rows with click and restores focus on Escape", () => {
    const run = vi.fn();
    render(
      <PaletteHarness commands={[{ id: "save", label: "Save", hotkey: "⌘S", run }]} openNote={vi.fn()} />,
    );
    openPalette();

    fireEvent.click(screen.getByText("Save"));
    expect(run).toHaveBeenCalledOnce();
    expect(document.activeElement?.textContent).toBe("Toggle palette");

    openPalette();
    fireEvent.keyDown(screen.getByLabelText("Search notes and commands"), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement?.textContent).toBe("Toggle palette");
  });

  it("persists recently used commands in storage", () => {
    const run = vi.fn();
    render(<PaletteHarness commands={[{ id: "save", label: "Save", run }]} openNote={vi.fn()} />);
    openPalette();
    fireEvent.click(screen.getByText("Save"));

    expect(window.localStorage.getItem(RECENT_KEY)).toBe(JSON.stringify(["save"]));

    openPalette();
    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("Commands")).toBeInTheDocument();
  });

  it("searches notes from the server for a non-empty query", async () => {
    const openNote = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([makeNote(), makeNote({ id: "/notes/typed.md", title: "Typed note" })]), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PaletteHarness commands={commands} openNote={openNote} />);
    openPalette();
    fireEvent.change(screen.getByLabelText("Search notes and commands"), {
      target: { value: "search" },
    });

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Searching|Typed/ })).toHaveLength(2),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search?q=search",
      expect.objectContaining({ headers: { "content-type": "application/json" } }),
    );
    expect(screen.getByText("Notes")).toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Searching notes")[0]);
    await waitFor(() => expect(openNote).toHaveBeenCalledOnce());
    expect(openNote).toHaveBeenCalledWith(expect.objectContaining({ id: "/notes/searching.md" }));

    vi.unstubAllGlobals();
  });
});
