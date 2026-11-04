import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../src/domain/types.ts";
import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { RenderedMarkdown } from "../../src/features/workspace/components/RenderedMarkdown.tsx";
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

  it("renders copy, remove and a disabled extract button", () => {
    render(<LiveMarkdownEditor value="![shot](/assets/a.png)" onChange={vi.fn()} ariaLabel="Bar note" />);
    const root = screen.getByLabelText("Bar note");
    expect(root.querySelectorAll(".cm-live-markdown-image-toolbar button")).toHaveLength(3);
    expect(label(root, "Copy image")).not.toBeNull();
    expect(label(root, "Remove image")).not.toBeNull();
    expect(label(root, "Extract text (coming soon)")?.disabled).toBe(true);
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
