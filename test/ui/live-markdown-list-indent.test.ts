import { describe, expect, it } from "vitest";

import { changeLiveMarkdownListIndentation } from "../../src/features/workspace/model/live-markdown.ts";
import { continueLiveMarkdownList } from "../../src/features/workspace/model/live-markdown.ts";

describe("changeLiveMarkdownListIndentation", () => {
  it("indents the current unordered list item by two spaces and preserves its caret", () => {
    expect(
      changeLiveMarkdownListIndentation("- first", { from: 3, to: 3 }, "indent"),
    ).toEqual({
      value: "  - first",
      selection: { from: 5, to: 5 },
    });
  });

  it("outdents up to two spaces without changing the marker or task content", () => {
    expect(
      changeLiveMarkdownListIndentation(
        "   - [x] nested task",
        { from: 12, to: 12 },
        "outdent",
      ),
    ).toEqual({
      value: " - [x] nested task",
      selection: { from: 10, to: 10 },
    });
  });

  it("updates every selected ordered, task, and nested list line with stable offsets", () => {
    const value = "1. first\n  - [ ] nested\n3. third";
    expect(
      changeLiveMarkdownListIndentation(value, { from: 0, to: value.length }, "indent"),
    ).toEqual({
      value: "  1. first\n    - [ ] nested\n  3. third",
      selection: { from: 2, to: value.length + 6 },
    });
  });

  it("does not include a final line merely because a selection ends at its start", () => {
    const value = "- first\n- second";
    expect(
      changeLiveMarkdownListIndentation(value, { from: 0, to: 8 }, "indent"),
    ).toEqual({
      value: "  - first\n- second",
      selection: { from: 2, to: 10 },
    });
  });

  it("returns null outside lists, for mixed selections, and when outdenting root items", () => {
    expect(
      changeLiveMarkdownListIndentation("plain text", { from: 0, to: 0 }, "indent"),
    ).toBeNull();
    expect(
      changeLiveMarkdownListIndentation("- item\nplain text", { from: 0, to: 17 }, "indent"),
    ).toBeNull();
    expect(
      changeLiveMarkdownListIndentation("- item", { from: 2, to: 2 }, "outdent"),
    ).toBeNull();
  });
});

describe("continueLiveMarkdownList", () => {
  it("renumbers direct ordered siblings after inserting a list item", () => {
    expect(continueLiveMarkdownList("1. first\n2. second", 8, 8)).toEqual({
      value: "1. first\n2. \n3. second",
      caret: 12,
    });
  });

  it("keeps nested ordered lists intact while renumbering their parent siblings", () => {
    const value = "1. first\n   1. nested\n2. second";
    expect(continueLiveMarkdownList(value, 8, 8)).toEqual({
      value: "1. first\n2. \n   1. nested\n3. second",
      caret: 12,
    });
  });

  it("exits an empty task item on the second Enter", () => {
    expect(continueLiveMarkdownList("- [ ] ", 6, 6)).toEqual({
      value: "",
      caret: 0,
    });
  });
});
