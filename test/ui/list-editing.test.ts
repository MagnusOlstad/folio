import { describe, expect, it } from "vitest";

import { continueMarkdownList } from "../../src/features/editor/list-editing.ts";

describe("continueMarkdownList", () => {
  it("returns null when the caret sits inside the list marker", () => {
    expect(continueMarkdownList("1. one", 0, 0)).toBeNull();
    expect(continueMarkdownList("1. one", 2, 2)).toBeNull();
  });

  it("splits an item and renumbers the following siblings", () => {
    expect(continueMarkdownList("1. one\n2. two\n3. three", 13, 13)).toEqual({
      value: "1. one\n2. two\n3. \n4. three",
      caret: 17,
    });
  });

  it("splits mid-content and renumbers the following siblings", () => {
    expect(continueMarkdownList("1. one\n2. two\n3. three", 12, 12)).toEqual({
      value: "1. one\n2. tw\n3. o\n4. three",
      caret: 16,
    });
  });

  it("leaves bullet lists unchanged apart from the split", () => {
    expect(continueMarkdownList("- a\n- b\n- c", 7, 7)).toEqual({
      value: "- a\n- b\n- \n- c",
      caret: 10,
    });
  });

  it("renumbers past deeper-indented sub-lists without touching them", () => {
    expect(
      continueMarkdownList("1. a\n2. b\n   1. x\n3. c", 9, 9),
    ).toEqual({
      value: "1. a\n2. b\n3. \n   1. x\n4. c",
      caret: 13,
    });
  });

  it("stops renumbering at a blank line", () => {
    expect(continueMarkdownList("1. a\n2. b\n\n3. c", 9, 9)).toEqual({
      value: "1. a\n2. b\n3. \n\n3. c",
      caret: 13,
    });
  });

  it("keeps each item's closing delimiter while renumbering", () => {
    expect(continueMarkdownList("1) a\n2) b\n3) c", 9, 9)).toEqual({
      value: "1) a\n2) b\n3) \n4) c",
      caret: 13,
    });
  });

  it("preserves task checkboxes on renumbered items", () => {
    expect(
      continueMarkdownList("1. [x] a\n2. [ ] b\n3. c", 17, 17),
    ).toEqual({
      value: "1. [x] a\n2. [ ] b\n3. [ ] \n4. c",
      caret: 25,
    });
  });

  it("handles multi-digit markers", () => {
    expect(
      continueMarkdownList("10. a\n11. b\n12. c", 11, 11),
    ).toEqual({
      value: "10. a\n11. b\n12. \n13. c",
      caret: 16,
    });
  });

  it("stops renumbering at a non-list line", () => {
    expect(continueMarkdownList("1. a\n2. b\ntext\n3. c", 9, 9)).toEqual({
      value: "1. a\n2. b\n3. \ntext\n3. c",
      caret: 13,
    });
  });

  it("still exits the list when Enter is pressed on an empty item", () => {
    expect(continueMarkdownList("1. a\n2. \n3. c", 8, 8)).toEqual({
      value: "1. a\n\n3. c",
      caret: 5,
    });
  });
});
