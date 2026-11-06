import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteTranslation, ViewerDocument } from "../../src/domain/types.ts";
import { DocumentView, type DocumentViewProps } from "../../src/features/workspace/components/DocumentView.tsx";
import { resetTranslationSettingsForTests } from "../../src/features/workspace/hooks/useTranslationSettings.ts";
import {
  migrateNoteTranslationChoice,
  migrateStoredNoteTranslationChoice,
  noteTranslationStorageKey,
  parseNoteTranslationChoices,
  readNoteTranslationChoices,
  setNoteTranslationChoice,
  translatedProgressLabel,
  withNoteTranslationChoice,
} from "../../src/features/workspace/model/note-translation.ts";
import { storedDraftDocument } from "../../src/lib/workspace.ts";

const noteDocument: ViewerDocument = {
  id: "/notes/hello.md",
  title: "Hei",
  type: "Note",
  description: "En test",
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  content: "# Hei\n\nDette er en test.",
  deletable: true,
  movable: true,
  status: "stable",
  staleAfter: null,
  stale: false,
  filedBy: null,
  filedAt: null,
  links: [],
  backlinks: [],
  suggestions: [],
};

function props(document: ViewerDocument): DocumentViewProps {
  const noop = vi.fn();
  const asyncNoop = vi.fn(async () => {});
  return {
    groupId: "g1", document, editKey: `g1:${document.id}`, draft: undefined, saving: false,
    deletingNoteId: null, movingFileId: null, exportingNoteId: null, filingDirectories: [],
    editingMetadataKey: null, metadataDrafts: {}, pathDraft: undefined, tagDraft: undefined,
    getScrollTop: () => 0, getSelection: () => undefined, onSelectionChange: noop, onScroll: noop,
    onBeginMetadataEditing: noop, onChangeMetadataDraft: noop, onFinishMetadataEditing: noop,
    onChangeContent: noop, onFileDraft: noop, onBeginEditing: noop, onFinishEditing: noop,
    onOpenDocument: asyncNoop, onToggleTask: asyncNoop,
    onBeginPathEditing: noop, onChangePath: noop, onFinishPathEditing: noop, onResetPath: noop,
    onBeginTagEditing: noop, onChangeTag: noop, onFinishTagEditing: noop,
    onDelete: asyncNoop, onExport: noop, filing: undefined, refile: undefined, focusFiling: false,
    onChangeFilingFields: noop, onRevealStandaloneFiling: noop, onConfirmFiling: noop, onDismissFiling: noop,
    onStartRefile: noop, onChangeRefileFields: noop, onAcceptRefile: noop, onDismissRefile: noop,
  } as DocumentViewProps;
}

describe("note translation model", () => {
  it("parses stored choices defensively", () => {
    expect(parseNoteTranslationChoices(null)).toEqual({});
    expect(parseNoteTranslationChoices("not json")).toEqual({});
    expect(parseNoteTranslationChoices("[1]")).toEqual({});
    expect(parseNoteTranslationChoices(JSON.stringify({ "/a.md": "en", "/b.md": "fr", "/c.md": "no" }))).toEqual({ "/a.md": "en", "/c.md": "no" });
  });

  it("sets, clears and migrates choices without mutating", () => {
    const start = { "/a.md": "en" } as const;
    expect(withNoteTranslationChoice(start, "/b.md", "no")).toEqual({ "/a.md": "en", "/b.md": "no" });
    expect(withNoteTranslationChoice(start, "/a.md", null)).toEqual({});
    expect(start).toEqual({ "/a.md": "en" });
    expect(migrateNoteTranslationChoice(start, "/a.md", "/x/a.md")).toEqual({ "/x/a.md": "en" });
    expect(migrateNoteTranslationChoice(start, "/zzz.md", "/y.md")).toBe(start);
  });

  it("persists per bundle and migrates the stored entry", () => {
    window.localStorage.clear();
    setNoteTranslationChoice("b1", "/a.md", "en");
    expect(JSON.parse(window.localStorage.getItem(noteTranslationStorageKey("b1")) ?? "{}")).toEqual({ "/a.md": "en" });
    expect(readNoteTranslationChoices("b2")).toEqual({});
    migrateStoredNoteTranslationChoice("b1", "/a.md", "/b.md");
    expect(readNoteTranslationChoices("b1")).toEqual({ "/b.md": "en" });
  });

  it("formats progress", () => {
    expect(translatedProgressLabel(3, 12)).toBe("Translating 3 of 12 paragraphs…");
  });
});

describe("DocumentView translation", () => {
  const fetchMock = vi.fn();
  let translation: NoteTranslation;
  let languageInfo: { noteLanguage: "no" | "en" | null; noteLanguageSource: "frontmatter" | "detected" | null };

  beforeEach(() => {
    window.localStorage.clear();
    resetTranslationSettingsForTests();
    translation = {
      id: noteDocument.id, target: "en", status: "pending", translatedBlocks: 3, totalBlocks: 12,
      title: "Hello", description: "A test", content: "# Hello\n\nThis is a test.",
    };
    languageInfo = { noteLanguage: null, noteLanguageSource: null };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const body = url.includes("/api/translation/settings") ? { enabled: true, available: true }
        : url.includes("/api/note/language") ? { id: noteDocument.id, ...languageInfo }
        : url.includes("/prioritize") ? { queued: true } : translation;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const translationCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/note/translation?"));

  it("shows no toggle and never calls the translation API for drafts", async () => {
    const draft = storedDraftDocument({ id: "untitled-1", content: "hi", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    render(<DocumentView {...props(draft)} />);
    await act(async () => {});
    expect(screen.queryByRole("group", { name: "Note language" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/note/translation"))).toBe(false);
  });

  it("hides the toggle for read-only files and when translation is disabled", async () => {
    render(<DocumentView {...props({ ...noteDocument, deletable: false, movable: false })} />);
    await act(async () => {});
    expect(screen.queryByRole("group", { name: "Note language" })).toBeNull();
  });

  it("renders the toggle for filed notes and a read-only translated view, then restores the editor", async () => {
    render(<DocumentView {...props(noteDocument)} />);
    const group = await screen.findByRole("group", { name: "Note language" });
    expect(group).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Original" })).toBeNull();
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector("[data-live-markdown-editor]")).not.toBeNull();
    expect(translationCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Translating 3 of 12 paragraphs…")).toBeInTheDocument();
    expect(await screen.findByText("This is a test.")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Hello" }).length).toBeGreaterThan(0);
    expect(screen.getByText("A test")).toBeInTheDocument();
    expect(document.querySelector("[data-live-markdown-editor]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Refile…" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Refile…" })).toHaveAttribute("title", "Switch back to the original to refile");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTitle("Click to edit title")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(noteTranslationStorageKey(null)) ?? "{}")).toEqual({ [noteDocument.id]: "en" });

    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(document.querySelector("[data-live-markdown-editor]")).not.toBeNull());
    expect(screen.queryByText("Translating 3 of 12 paragraphs…")).toBeNull();
    expect(window.localStorage.getItem(noteTranslationStorageKey(null))).toBe("{}");
  });

  describe("known note language", () => {
    beforeEach(() => {
      languageInfo = { noteLanguage: "no", noteLanguageSource: "detected" };
    });
    const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

    it("highlights the original language and marks it as the source", async () => {
      render(<DocumentView {...props(noteDocument)} />);
      await waitFor(() => expect(pressed("Norsk")).toBe("true"));
      expect(pressed("English")).toBe("false");
      const norsk = screen.getByRole("button", { name: "Norsk" });
      expect(norsk).toHaveAccessibleDescription("Original language (Norwegian) — detected from the text");
      expect(screen.getByRole("button", { name: "English" })).not.toHaveAttribute("aria-describedby");
      expect(translationCalls()).toHaveLength(0);
    });

    it("switches to the other language and back, and clicking the original never fetches a translation", async () => {
      render(<DocumentView {...props(noteDocument)} />);
      await waitFor(() => expect(pressed("Norsk")).toBe("true"));
      fireEvent.click(screen.getByRole("button", { name: "Norsk" }));
      expect(translationCalls()).toHaveLength(0);
      expect(document.querySelector("[data-live-markdown-editor]")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "English" }));
      expect(await screen.findByText("This is a test.")).toBeInTheDocument();
      expect(pressed("English")).toBe("true");
      expect(pressed("Norsk")).toBe("false");
      expect(translationCalls().every(([url]) => String(url).includes("target=en"))).toBe(true);
      expect(document.querySelector("[data-live-markdown-editor]")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Norsk" }));
      await waitFor(() => expect(document.querySelector("[data-live-markdown-editor]")).not.toBeNull());
      expect(pressed("Norsk")).toBe("true");
      expect(window.localStorage.getItem(noteTranslationStorageKey(null))).toBe("{}");
    });

    it("treats a stored choice equal to the note's language as Original and cleans it up", async () => {
      setNoteTranslationChoice(null, noteDocument.id, "no");
      render(<DocumentView {...props(noteDocument)} />);
      await waitFor(() => expect(window.localStorage.getItem(noteTranslationStorageKey(null))).toBe("{}"));
      expect(pressed("Norsk")).toBe("true");
      expect(document.querySelector("[data-live-markdown-editor]")).not.toBeNull();
      expect(translationCalls().every(([url]) => !String(url).includes("target=no"))).toBe(true);
    });
  });

  it("keeps the neutral behaviour when the language is unknown", async () => {
    render(<DocumentView {...props(noteDocument)} />);
    await screen.findByRole("group", { name: "Note language" });
    expect(screen.getByRole("button", { name: "Norsk" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(await screen.findByText("This is a test.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(document.querySelector("[data-live-markdown-editor]")).not.toBeNull());
  });

  it("restores the remembered choice and shows an error with the toggle still available", async () => {
    setNoteTranslationChoice(null, noteDocument.id, "no");
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/api/translation/settings")
        ? new Response(JSON.stringify({ enabled: true, available: true }), { status: 200 })
        : new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    render(<DocumentView {...props(noteDocument)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("button", { name: "Norsk" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Norsk" })).toBeEnabled();
  });
});

describe("Background translation setting", () => {
  it("PUTs the switch and updates the toggle visibility", async () => {
    window.localStorage.clear();
    resetTranslationSettingsForTests();
    let enabled = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/translation/settings")) {
        if (init?.method === "PUT") enabled = JSON.parse(String(init.body)).enabled;
        return new Response(JSON.stringify({ enabled, available: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ModelSettings } = await import("../../src/features/settings/components/ModelSettings.tsx");
    render(
      <>
        <ModelSettings controls={{ status: null, actionModel: null, action: null, error: "", install: vi.fn(), remove: vi.fn(), select: vi.fn(), selectTranscription: vi.fn() }} />
        <DocumentView {...props(noteDocument)} />
      </>,
    );
    const settingsSwitch = within(await screen.findByRole("group", { name: "Background translation" })).getByRole("switch");
    const headerSwitch = await screen.findByRole("switch", { name: "Background translation" });
    expect(settingsSwitch).not.toBeChecked();
    expect(headerSwitch).toHaveAttribute("aria-checked", "false");
    expect(headerSwitch).toHaveAttribute("title", expect.stringContaining("Translation off"));
    expect(screen.queryByRole("group", { name: "Note language" })).toBeNull();
    expect(document.querySelector("[data-live-markdown-editor]")).not.toBeNull();
    fireEvent.click(settingsSwitch);
    expect(await screen.findByRole("group", { name: "Note language" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/api/translation/settings") && init?.method === "PUT")).toBe(true);
    expect(settingsSwitch).toBeChecked();
    expect(screen.getByRole("switch", { name: "Background translation" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: "Background translation" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Note language" })).toBeNull());
    expect(settingsSwitch).not.toBeChecked();
  });

  it("restores the stored language when switched back on and rolls back on a failed save", async () => {
    window.localStorage.clear();
    resetTranslationSettingsForTests();
    setNoteTranslationChoice(null, noteDocument.id, "no");
    let enabled = false;
    let failPut = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/translation/settings")) {
        if (init?.method === "PUT") {
          if (failPut) return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
          enabled = JSON.parse(String(init.body)).enabled;
        }
        return new Response(JSON.stringify({ enabled, available: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: noteDocument.id, target: "no", status: "ready", translatedBlocks: 1, totalBlocks: 1, title: "Hei", description: "", content: "Norsk tekst" }), { status: 200 });
    }));
    render(<DocumentView {...props(noteDocument)} />);
    const headerSwitch = await screen.findByRole("switch", { name: "Background translation" });
    fireEvent.click(headerSwitch);
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
    expect(screen.getByRole("switch", { name: "Background translation" })).toHaveAttribute("aria-checked", "false");
    failPut = false;
    fireEvent.click(screen.getByRole("switch", { name: "Background translation" }));
    expect(await screen.findByRole("button", { name: "Norsk" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Norsk tekst")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
