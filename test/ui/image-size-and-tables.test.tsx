import { render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { setLiveMarkdownFocus } from "../../src/features/workspace/model/live-markdown.ts";
import {
  formatImageAlt,
  imageAltWidthChange,
  parseImageAlt,
} from "../../src/features/workspace/model/image-size.ts";
import {
  parseAlignment,
  parseInline,
  parseTable,
  renderTable,
  splitTableRow,
} from "../../src/features/workspace/model/table-model.ts";

describe("image alt sizing", () => {
  it("parses width suffixes", () => {
    expect(parseImageAlt("photo|300")).toEqual({ alt: "photo", width: 300, height: null });
    expect(parseImageAlt("photo|300x200")).toEqual({ alt: "photo", width: 300, height: 200 });
    expect(parseImageAlt("a|b")).toEqual({ alt: "a|b", width: null, height: null });
    expect(parseImageAlt("|120")).toEqual({ alt: "", width: 120, height: null });
  });

  it("formats and rewrites the alt only", () => {
    expect(formatImageAlt("photo|300", 200.4)).toBe("photo|200");
    expect(formatImageAlt("photo|300", null)).toBe("photo");
    const source = "![my \\] pic|10](/assets/a.png)";
    const change = imageAltWidthChange(source, 250)!;
    expect(source.slice(0, change.from) + change.insert + source.slice(change.to)).toBe(
      "![my \\] pic|250](/assets/a.png)",
    );
    expect(imageAltWidthChange("not an image", 5)).toBeNull();
  });
});

describe("table model", () => {
  it("splits rows honoring escaped pipes and optional outer pipes", () => {
    expect(splitTableRow("| a | b \\| c |")).toEqual(["a", "b \\| c"]);
    expect(splitTableRow("a | b | c")).toEqual(["a", "b", "c"]);
    expect(splitTableRow("| a | |")).toEqual(["a", ""]);
  });

  it("parses alignment", () => {
    expect(parseAlignment(":---:")).toBe("center");
    expect(parseAlignment("---:")).toBe("right");
    expect(parseAlignment(":--")).toBe("left");
    expect(parseAlignment("---")).toBeNull();
    expect(parseAlignment("abc")).toBeUndefined();
  });

  it("parses tables and pads short rows", () => {
    const table = parseTable("Name | Qty\n:--|--:\nfoo | 1\nbar");
    expect(table).toEqual({
      header: ["Name", "Qty"],
      align: ["left", "right"],
      rows: [["foo", "1"], ["bar", ""]],
    });
    expect(parseTable("a | b\nnot | delimiter")).toBeNull();
  });

  it("renders inline markdown safely", () => {
    expect(parseInline("**b** `c|d` [x](javascript:alert(1))")).toEqual([
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "code", text: "c|d" },
      { type: "text", text: " [x](javascript:alert(1))" },
    ]);
    const table = parseTable("| <img src=x onerror=1> | b |\n|:-:|---|\n| [l](https://e.com) | ~~s~~ |")!;
    const element = renderTable(table);
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector("th")?.style.textAlign).toBe("center");
    expect(element.querySelector("a")?.getAttribute("href")).toBe("https://e.com");
    expect(element.querySelector("del")?.textContent).toBe("s");
  });
});

describe("live editor tables", () => {
  const value = "Intro\n\n| a | b |\n|---|---|\n| **1** | 2 |\n\nOutro";

  it("renders a widget unless the cursor is inside the table", () => {
    render(<LiveMarkdownEditor value={value} onChange={vi.fn()} ariaLabel="Table note" />);
    const editor = screen.getByLabelText("Table note");
    const view = EditorView.findFromDOM(editor)!;
    expect(editor.querySelector(".cm-live-markdown-table-grid")).toBeTruthy();
    expect(editor.querySelector("strong")?.textContent).toBe("1");

    act(() => {
      view.dispatch({ selection: { anchor: value.indexOf("| a") + 3 }, effects: setLiveMarkdownFocus.of(true) });
    });
    expect(editor.querySelector(".cm-live-markdown-table-grid")).toBeNull();
    expect(editor.querySelector(".cm-live-markdown-table")).toBeTruthy();

    act(() => {
      view.dispatch({ selection: { anchor: 0 } });
    });
    expect(editor.querySelector(".cm-live-markdown-table-grid")).toBeTruthy();
  });
});
