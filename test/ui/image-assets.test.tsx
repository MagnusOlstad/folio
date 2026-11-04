import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { RenderedMarkdown } from "../../src/features/workspace/components/RenderedMarkdown.tsx";
import { cleanExtractedText } from "../../src/features/workspace/model/image-ocr.ts";
import {
  createUploadPlaceholder,
  pendingImageUploads,
} from "../../src/features/workspace/model/image-paste.ts";
import {
  altFromFilename,
  assetUrl,
  imageMarkdown,
  isSupportedImageFile,
  resolveAssetHref,
} from "../../src/lib/assets.ts";

const rangeProto = Range.prototype as {
  getClientRects?: Range["getClientRects"];
  getBoundingClientRect?: Range["getBoundingClientRect"];
};
const originalRangeRects = { getClientRects: rangeProto.getClientRects, getBoundingClientRect: rangeProto.getBoundingClientRect };

// jsdom lacks Range layout APIs that CodeMirror's scheduled measure frame calls.
beforeAll(() => {
  rangeProto.getClientRects ??= () =>
    Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
  rangeProto.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
});

afterAll(() => {
  rangeProto.getClientRects = originalRangeRects.getClientRects;
  rangeProto.getBoundingClientRect = originalRangeRects.getBoundingClientRect;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const png = (name = "Screen Shot.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

describe("asset helpers", () => {
  it("accepts only raster image types", () => {
    expect(isSupportedImageFile({ type: "image/png" })).toBe(true);
    expect(isSupportedImageFile({ type: "image/webp" })).toBe(true);
    expect(isSupportedImageFile({ type: "image/svg+xml" })).toBe(false);
    expect(isSupportedImageFile({ type: "text/plain" })).toBe(false);
  });

  it("resolves only single-segment asset hrefs", () => {
    expect(resolveAssetHref("/assets/a-1.png")).toBe("/assets/a-1.png");
    expect(resolveAssetHref("../assets/a.png")).toBe("/assets/a.png");
    expect(resolveAssetHref("/assets/a%20b.png")).toBeNull();
    for (const bad of ["/assets/x/y.png", "/assets/../x.png", "https://x.com/assets/a.png", "/other/a.png", "assets", "#upload-1", "//assets/a.png", undefined])
      expect(resolveAssetHref(bad)).toBeNull();
  });

  it("escapes brackets in alt text and builds urls", () => {
    expect(imageMarkdown("a [b] c", "/assets/x.png")).toBe("![a \\[b\\] c](/assets/x.png)");
    expect(altFromFilename("Screen_Shot-1.png")).toBe("Screen Shot 1");
    expect(assetUrl("/assets/x.png", "b 1")).toBe("/api/assets?path=%2Fassets%2Fx.png&bundle=b%201");
  });

  it("filters uploads and makes unique placeholders", () => {
    const uploads = pendingImageUploads([png(), new File(["x"], "a.svg", { type: "image/svg+xml" })]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].alt).toBe("Screen Shot");
    expect(createUploadPlaceholder()).not.toBe(createUploadPlaceholder());
  });
});

describe("LiveMarkdownEditor image paste", () => {
  it("replaces the upload placeholder with the final markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: "/assets/2026-11-04-screen-shot-a1b2c3.png" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();
    render(<LiveMarkdownEditor value="Hello" onChange={onChange} ariaLabel="Paste note" />);
    const editor = screen.getByLabelText("Paste note");

    fireEvent.paste(editor, { clipboardData: { files: [png()] } });
    expect(onChange.mock.calls.at(-1)?.[0]).toMatch(/^!\[Uploading image…\]\(#upload-.+\)Hello$/);
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith("![Screen Shot](/assets/2026-11-04-screen-shot-a1b2c3.png)Hello"),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["content-type"]).toBe("image/png");
  });

  it("removes the placeholder and reports upload failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Too big." }), { status: 413 }),
    ));
    const onChange = vi.fn();
    const onError = vi.fn();
    render(<LiveMarkdownEditor value="" onChange={onChange} onError={onError} ariaLabel="Fail note" />);
    fireEvent.paste(screen.getByLabelText("Fail note"), { clipboardData: { files: [png()] } });
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Too big."));
    expect(EditorView.findFromDOM(screen.getByLabelText("Fail note"))?.state.doc.toString()).toBe("");
  });

  it("leaves non-image pastes alone", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveMarkdownEditor value="" onChange={vi.fn()} ariaLabel="Text note" />);
    fireEvent.paste(screen.getByLabelText("Text note"), {
      clipboardData: { files: [new File(["x"], "a.svg", { type: "image/svg+xml" })], getData: () => "" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(EditorView.findFromDOM(screen.getByLabelText("Text note"))?.state.doc.toString()).toBe("");
  });

  it("does nothing when read-only", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveMarkdownEditor value="" onChange={vi.fn()} readOnly ariaLabel="Locked note" />);
    fireEvent.paste(screen.getByLabelText("Locked note"), { clipboardData: { files: [png()] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders asset images as widgets until the cursor reaches them", () => {
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} ariaLabel="Image note" />);
    const image = screen.getByLabelText("Image note").querySelector("img.cm-live-markdown-image");
    expect(image?.getAttribute("src")).toContain("/api/assets?path=%2Fassets%2Fa.png");
    expect(image?.getAttribute("alt")).toBe("shot");
  });
});

describe("LiveMarkdownEditor image toolbar", () => {
  const label = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

  it("renders copy, remove and an enabled extract button", () => {
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} ariaLabel="Bar note" />);
    const root = screen.getByLabelText("Bar note");
    expect(root.querySelectorAll(".cm-live-markdown-image-toolbar button")).toHaveLength(3);
    expect(label(root, "Copy image")).not.toBeNull();
    expect(label(root, "Remove image")).not.toBeNull();
    expect(label(root, "Extract text")?.disabled).toBe(false);
  });

  it("omits remove when read-only", () => {
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} readOnly ariaLabel="RO bar" />);
    const root = screen.getByLabelText("RO bar");
    expect(label(root, "Remove image")).toBeNull();
    expect(label(root, "Copy image")).not.toBeNull();
  });

  it("removes the image inline and keeps surrounding text", () => {
    const onChange = vi.fn();
    render(<LiveMarkdownEditor value="a ![shot](/assets/a.png) b" onChange={onChange} ariaLabel="Inline rm" />);
    const root = screen.getByLabelText("Inline rm");
    fireEvent.click(label(root, "Remove image")!);
    expect(onChange).toHaveBeenLastCalledWith("a  b");
  });

  it("removes the whole line when the image was alone, and undo restores it", () => {
    const onChange = vi.fn();
    render(<LiveMarkdownEditor value={"one\n![shot](/assets/a.png)\ntwo"} onChange={onChange} ariaLabel="Line rm" />);
    const root = screen.getByLabelText("Line rm");
    fireEvent.click(label(root, "Remove image")!);
    expect(onChange).toHaveBeenLastCalledWith("one\ntwo");
    const view = EditorView.findFromDOM(root)!;
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("one\n![shot](/assets/a.png)\ntwo");
  });

  it("removes a lone image completely", () => {
    const onChange = vi.fn();
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={onChange} ariaLabel="Only rm" />);
    fireEvent.click(label(screen.getByLabelText("Only rm"), "Remove image")!);
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("copies the image as png to the clipboard", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
    const write = vi.fn().mockResolvedValue(undefined);
    class FakeClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { write } });
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} ariaLabel="Copy note" />);
    const button = label(screen.getByLabelText("Copy note"), "Copy image")!;
    fireEvent.click(button);
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    const item = write.mock.calls[0][0][0] as FakeClipboardItem;
    expect(Object.keys(item.items)).toEqual(["image/png"]);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/assets?path=%2Fassets%2Fa.png");
    await waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copied"));
  });

  it("reports a copy failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 404 })));
    const onError = vi.fn();
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} onError={onError} ariaLabel="Copy fail" />);
    fireEvent.click(label(screen.getByLabelText("Copy fail"), "Copy image")!);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not copy the image."));
  });
});

describe("LiveMarkdownEditor image text extraction", () => {
  const label = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  const button = (root: HTMLElement, name: string) =>
    Array.from(root.querySelectorAll<HTMLButtonElement>(".cm-live-markdown-ocr-button")).find((item) => item.textContent === name) ?? null;
  const ocrResponse = (text = "# Title\n\nBody", cached = false) =>
    new Response(JSON.stringify({ text, cached }), { status: 200 });

  it("requests extraction and opens a preview with the text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ocrResponse("# Title\n\nBody", true));
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} ariaLabel="OCR note" />);
    const root = screen.getByLabelText("OCR note");
    const extract = label(root, "Extract text")!;
    fireEvent.click(extract);
    expect(extract.getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(root.querySelector(".cm-live-markdown-ocr-text")).not.toBeNull());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/assets/ocr");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ path: "/assets/a.png" });
    expect(root.querySelector(".cm-live-markdown-ocr-text")?.textContent).toBe("# Title\n\nBody");
    expect(root.querySelector(".cm-live-markdown-ocr-note")?.textContent).toBe("(cached)");
    expect(extract.hasAttribute("aria-busy")).toBe(false);
    fireEvent.click(button(root, "Close")!);
    expect(root.querySelector(".cm-live-markdown-ocr-preview")).toBeNull();
  });

  it("closes the preview with Escape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ocrResponse()));
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} ariaLabel="Esc note" />);
    const root = screen.getByLabelText("Esc note");
    fireEvent.click(label(root, "Extract text")!);
    await waitFor(() => expect(root.querySelector(".cm-live-markdown-ocr-preview")).not.toBeNull());
    fireEvent.keyDown(root, { key: "Escape" });
    expect(root.querySelector(".cm-live-markdown-ocr-preview")).toBeNull();
  });

  it("copies the extracted text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ocrResponse("hello")));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} ariaLabel="Copy ocr" />);
    const root = screen.getByLabelText("Copy ocr");
    fireEvent.click(label(root, "Extract text")!);
    await waitFor(() => expect(button(root, "Copy")).not.toBeNull());
    fireEvent.click(button(root, "Copy")!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello"));
    await waitFor(() => expect(button(root, "Copied")).not.toBeNull());
  });

  it("inserts the text below the image line and supports undo", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ocrResponse("Line one\nLine two\n")));
    const onChange = vi.fn();
    render(<LiveMarkdownEditor value={"intro\na ![shot](/assets/a.png) tail\nafter"} onChange={onChange} ariaLabel="Insert ocr" />);
    const root = screen.getByLabelText("Insert ocr");
    fireEvent.click(label(root, "Extract text")!);
    await waitFor(() => expect(button(root, "Insert below")).not.toBeNull());
    fireEvent.click(button(root, "Insert below")!);
    expect(onChange).toHaveBeenLastCalledWith("intro\na ![shot](/assets/a.png) tail\n\nLine one\nLine two\n\nafter");
    expect(root.querySelector(".cm-live-markdown-ocr-preview")).toBeNull();
    const view = EditorView.findFromDOM(root)!;
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("intro\na ![shot](/assets/a.png) tail\nafter");
  });

  it("reports extraction errors and resets the button", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Install LightOnOCR in Settings → Models to extract text." }), { status: 409 }),
    ));
    const onError = vi.fn();
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} onError={onError} ariaLabel="Err ocr" />);
    const root = screen.getByLabelText("Err ocr");
    const extract = label(root, "Extract text")!;
    fireEvent.click(extract);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Install LightOnOCR in Settings → Models to extract text."));
    expect(extract.hasAttribute("aria-busy")).toBe(false);
    expect(extract.disabled).toBe(false);
    expect(root.querySelector(".cm-live-markdown-ocr-preview")).toBeNull();
  });

  it("hides insert when read-only but keeps copy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ocrResponse()));
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} readOnly ariaLabel="RO ocr" />);
    const root = screen.getByLabelText("RO ocr");
    fireEvent.click(label(root, "Extract text")!);
    await waitFor(() => expect(button(root, "Copy")).not.toBeNull());
    expect(button(root, "Insert below")).toBeNull();
  });
});

describe("RenderedMarkdown images", () => {
  it("maps asset hrefs to the asset endpoint", () => {
    const note = {
      id: "/notes/a.md", title: "A", type: "Note", description: "", tags: [], createdAt: "", content: "![shot](/assets/a.png)",
      deletable: false, movable: false, status: "stable", staleAfter: null, stale: false, filedBy: null, filedAt: null,
      links: [], backlinks: [], suggestions: [],
    } as ViewerDocument;
    render(<RenderedMarkdown document={note} groupId="g" saving={false} onOpenDocument={vi.fn()} onToggleTask={vi.fn()} />);
    expect(screen.getByAltText("shot").getAttribute("src")).toContain("/api/assets?path=%2Fassets%2Fa.png");
  });
});

describe("cleanExtractedText", () => {
  it("strips the table wrapper and annotation header", () => {
    const raw = "<table>\n### Table - Definisjoner\n*Type: listing*\n\n|  |  |\n|---|---|\n| 4 | Definisjoner |\n\n</table>\n";
    expect(cleanExtractedText(raw)).toBe("|  |  |\n|---|---|\n| 4 | Definisjoner |");
  });

  it("strips other annotation headers", () => {
    expect(cleanExtractedText("### Chart - Sales\n*Type: bar*\n\nbody")).toBe("body");
    expect(cleanExtractedText("### Figure - X\n*Type: photo*\ncaption")).toBe("caption");
  });

  it("keeps real HTML tables untouched", () => {
    const html = "<table>\n<tr><td>a</td></tr>\n</table>";
    expect(cleanExtractedText(html)).toBe(html);
  });

  it("leaves plain text untouched", () => {
    expect(cleanExtractedText("# Title\n\nBody text")).toBe("# Title\n\nBody text");
  });
});
