import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  captionAltChange,
  captionInsertChange,
  captionToAlt,
  cleanCaptionText,
  nextCaptionState,
  type CaptionPreviewState,
} from "../../src/features/workspace/model/image-caption.ts";

const idle: CaptionPreviewState = { status: "idle" };
const success = { type: "success", text: "A cat", cached: false, model: "gemma4" } as const;

describe("caption state", () => {
  it("runs idle -> describing -> preview -> idle", () => {
    const describing = nextCaptionState(idle, { type: "start" });
    expect(describing).toEqual({ status: "describing" });
    const preview = nextCaptionState(describing, success);
    expect(preview).toEqual({ status: "preview", text: "A cat", cached: false, model: "gemma4" });
    expect(nextCaptionState(preview, { type: "close" })).toEqual(idle);
  });

  it("ignores out-of-order actions", () => {
    expect(nextCaptionState(idle, success)).toBe(idle);
    expect(nextCaptionState({ status: "describing" }, { type: "start" })).toEqual({ status: "describing" });
    expect(nextCaptionState({ status: "describing" }, { type: "close" })).toEqual({ status: "describing" });
  });

  it("returns to idle on failure and holds a blocked panel until closed", () => {
    expect(nextCaptionState({ status: "describing" }, { type: "failure" })).toEqual(idle);
    const blocked = nextCaptionState({ status: "describing" }, { type: "blocked", code: "CAPTION_MODEL_NOT_INSTALLED", modelId: "qwen35" });
    expect(blocked).toEqual({ status: "blocked", code: "CAPTION_MODEL_NOT_INSTALLED", modelId: "qwen35" });
    expect(nextCaptionState(blocked, { type: "start" })).toBe(blocked);
    expect(nextCaptionState(blocked, { type: "close" })).toEqual(idle);
  });
});

describe("caption text", () => {
  it("collapses whitespace but keeps paragraphs", () => {
    expect(cleanCaptionText("  A  cat\non a sofa.\r\n\r\n\r\nIt sleeps.  ")).toBe("A cat on a sofa.\n\nIt sleeps.");
    expect(cleanCaptionText(" \n ")).toBe("");
  });

  it("makes alt text single-line and safe for Markdown", () => {
    expect(captionToAlt("A [red] door\n\nwith a | pipe \\ x")).toBe("A \\[red\\] door with a / pipe \\\\ x");
  });

  it("inserts the description as a block after the image line", () => {
    const doc = Text.of(["intro", "![a](/assets/x.png)", "outro"]);
    const range = { from: 6, to: 25 };
    expect(captionInsertChange(doc, range, " A cat ")).toEqual({ from: 25, insert: "\n\nA cat\n" });
    expect(captionInsertChange(doc, range, "  ")).toBeNull();
  });

  it("replaces the alt text and keeps the size suffix", () => {
    expect(captionAltChange("![old](/assets/x.png)", "A cat")).toEqual({ from: 2, to: 5, insert: "A cat" });
    expect(captionAltChange("![old|300](/assets/x.png)", "A cat")).toEqual({ from: 2, to: 9, insert: "A cat|300" });
    expect(captionAltChange("![old|300x200](/assets/x.png)", "A cat")).toEqual({ from: 2, to: 13, insert: "A cat|300x200" });
    expect(captionAltChange("![](/assets/x.png)", "A cat")).toEqual({ from: 2, to: 2, insert: "A cat" });
    expect(captionAltChange("not an image", "A cat")).toBeNull();
    expect(captionAltChange("![a](/assets/x.png)", "  ")).toBeNull();
  });
});
