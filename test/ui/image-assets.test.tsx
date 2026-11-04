import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
