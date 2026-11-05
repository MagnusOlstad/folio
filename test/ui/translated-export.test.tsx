import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslatedExportJob, ViewerDocument } from "../../src/domain/types.ts";
import { NoteExportMenu } from "../../src/features/workspace/components/NoteExportMenu.tsx";
import { draftFilingGuidance } from "../../src/lib/workspace.ts";
import { translatedExportFilename } from "../../src/features/workspace/model/note-export.ts";
import {
  TRANSLATED_EXPORT_STORAGE_KEY,
  deliverTranslatedExport,
  parseTranslatedExportPreferences,
  translatedDraftContent,
} from "../../src/features/workspace/model/translated-export.ts";

const note: ViewerDocument = {
  id: "/notes/gaustatoppen.md", title: "Gaustatoppen", type: "Note", description: "Fjell", tags: [],
  createdAt: "2026-01-01T00:00:00.000Z", content: "Original", deletable: true, movable: true, status: "stable",
  staleAfter: null, stale: false, filedBy: null, filedAt: null, links: [], backlinks: [], suggestions: [],
};
const result = { title: "Gaustatoppen Berg", description: "Berg", content: "# Gaustatoppen Berg\n\nEin Berg." };

describe("translated export model", () => {
  it("puts the language code before the extension", () => {
    expect(translatedExportFilename("Gaustatoppen", "markdown", "de")).toBe("Gaustatoppen.de.md");
    expect(translatedExportFilename("a: b", "pdf", "no")).toBe("a- b.no.pdf");
    expect(translatedExportFilename("", "pdf", "fr")).toBe("Untitled.fr.pdf");
  });

  it("parses stored preferences defensively", () => {
    expect(parseTranslatedExportPreferences("junk")).toEqual({ target: "en", destination: "markdown" });
    expect(parseTranslatedExportPreferences(JSON.stringify({ target: "de", destination: "pdf" }))).toEqual({ target: "de", destination: "pdf" });
    expect(parseTranslatedExportPreferences(JSON.stringify({ target: "xx", destination: 3 }))).toEqual({ target: "en", destination: "markdown" });
  });

  it("builds draft content without repeating the title heading", () => {
    const snapshot = { id: note.id, title: "Gaustatoppen Berg", description: "", content: result.content, draft: false };
    expect(translatedDraftContent(snapshot)).toBe("\n# Gaustatoppen Berg\n\nEin Berg.");
    expect(translatedDraftContent({ ...snapshot, content: "Nur Text." })).toBe("\n# Gaustatoppen Berg\n\nNur Text.");
    expect(draftFilingGuidance(translatedDraftContent(snapshot))).toBe("");
  });

  it("delivers to each destination", async () => {
    const deps = { exportSnapshot: vi.fn(async () => {}), createDraft: vi.fn(), setMessage: vi.fn() };
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    await deliverTranslatedExport(deps, note, result, "de", "clipboard");
    expect(writeText).toHaveBeenCalledWith(result.content);
    expect(deps.setMessage).toHaveBeenCalledWith("Copied German translation");
    await deliverTranslatedExport(deps, note, result, "de", "draft");
    expect(deps.createDraft).toHaveBeenCalledWith("\n# Gaustatoppen Berg\n\nEin Berg.");
    await deliverTranslatedExport(deps, note, result, "de", "markdown");
    expect(deps.exportSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Gaustatoppen Berg", content: result.content }), "markdown", "Gaustatoppen.de.md", note.id, "");
    await deliverTranslatedExport(deps, note, result, "de", "pdf");
    expect(deps.exportSnapshot).toHaveBeenLastCalledWith(expect.anything(), "pdf", "Gaustatoppen.de.pdf", note.id, "");
  });
});

describe("translated export partial failures", () => {
  it("still delivers and reports paragraphs kept in the original language", async () => {
    const deps = { exportSnapshot: vi.fn(async () => {}), createDraft: vi.fn(), setMessage: vi.fn() };
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const partial = { ...result, failedBlocks: 2 };
    await deliverTranslatedExport(deps, note, partial, "de", "clipboard");
    expect(writeText).toHaveBeenCalled();
    expect(deps.setMessage).toHaveBeenCalledWith("Copied German translation — 2 paragraphs were kept in the original language.");
    await deliverTranslatedExport(deps, note, { ...result, failedBlocks: 1 }, "de", "draft");
    expect(deps.setMessage).toHaveBeenLastCalledWith("Opened German translation as a new draft — 1 paragraph was kept in the original language.");
    await deliverTranslatedExport(deps, note, partial, "de", "pdf");
    expect(deps.exportSnapshot).toHaveBeenLastCalledWith(expect.anything(), "pdf", "Gaustatoppen.de.pdf", note.id, " — 2 paragraphs were kept in the original language.");
  });
});

describe("translated export dialog", () => {
  const fetchMock = vi.fn();
  const onDeliver = vi.fn(async () => {});
  let jobs: TranslatedExportJob[];
  const job = (overrides: Partial<TranslatedExportJob>): TranslatedExportJob => ({
    jobId: "j1", id: note.id, target: "de", status: "running", translatedBlocks: 4, totalBlocks: 12, ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    window.localStorage.clear();
    onDeliver.mockClear();
    jobs = [job({ translatedBlocks: 4 }), job({ status: "done", translatedBlocks: 12, ...result })];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return new Response(JSON.stringify(job({ translatedBlocks: 0 })), { status: 202 });
      if (method === "DELETE") return new Response(JSON.stringify({ jobId: "j1", status: "cancelled" }), { status: 200 });
      return new Response(JSON.stringify(jobs.shift() ?? job({})), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderMenu(available = true, translate = true) {
    return render(
      <NoteExportMenu
        title={note.title}
        exporting={false}
        onExport={vi.fn()}
        translate={translate ? { document: note, available, onDeliver } : undefined}
      />,
    );
  }
  const openDialog = () => {
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Translate…" }));
  };
  const tick = (ms = 1600) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("marks Finnish as experimental through the radio's description", () => {
    renderMenu();
    openDialog();
    const finnish = screen.getByRole("radio", { name: /Suomi/ });
    expect(finnish).toHaveAccessibleDescription("Experimental — lower quality");
    expect(screen.getByRole("radio", { name: "Deutsch" })).not.toHaveAccessibleDescription();
  });

  it("offers Translate… only for translatable notes and disables it without a model", () => {
    renderMenu(true, false);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.queryByRole("menuitem", { name: "Translate…" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Markdown" })).toBeInTheDocument();
  });

  it("disables the item with a hint when translation is unavailable", () => {
    renderMenu(false);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.getByRole("menuitem", { name: "Translate…" })).toBeDisabled();
  });

  it("opens the dialog, shows progress, delivers on done and remembers the choice", async () => {
    renderMenu();
    openDialog();
    const dialog = screen.getByRole("dialog", { name: "Translate and export" });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Deutsch" }));
    fireEvent.click(screen.getByRole("radio", { name: "New draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    await tick(0);
    await tick();
    expect(screen.getByText("Translating 4 of 12 paragraphs…")).toBeInTheDocument();
    await tick();
    expect(onDeliver).toHaveBeenCalledWith(note, expect.objectContaining({ content: result.content }), "de", "draft");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(TRANSLATED_EXPORT_STORAGE_KEY) ?? "{}")).toEqual({ target: "de", destination: "draft" });
  });

  it("cancels the running job with DELETE and closes", async () => {
    renderMenu();
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    await tick(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/note/translation/export/j1") && init?.method === "DELETE")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and returns focus to the Export trigger", async () => {
    renderMenu();
    openDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await tick(50);
    // rAF is real; flush it.
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    expect(screen.getByRole("button", { name: "Export" })).toHaveFocus();
  });

  it("shows a settings hint when no generation model is installed (503) and a retry", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "No model" }), { status: 503 }));
    renderMenu();
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    await tick(0);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Install a generation model in Settings");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows a failed job's error with retry", async () => {
    jobs = [job({ status: "failed", error: "Model crashed" })];
    renderMenu();
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    await tick(0);
    await tick();
    expect(screen.getByRole("alert")).toHaveTextContent("Model crashed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
