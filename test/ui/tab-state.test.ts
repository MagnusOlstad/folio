import { describe, expect, it } from "vitest";

import type { TabGroup } from "../../src/domain/types.ts";
import {
  closeGroupTab,
  mergeClosedGroup,
  moveGroupTab,
  openPreviewTab,
  pinGroupTab,
} from "../../src/features/workspace/model/tab-state.ts";

const groups: TabGroup[] = [
  { id: "left", tabs: ["a", "b"], activeId: "b", previewId: null },
  { id: "right", tabs: ["c"], activeId: "c", previewId: null },
];

describe("workspace tab state", () => {
  it("selects an adjacent tab when the active tab closes", () => {
    expect(closeGroupTab(groups, "left", "b")[0]).toEqual({
      id: "left",
      tabs: ["a"],
      activeId: "a",
      previewId: null,
    });
  });

  it("moves a tab between groups without duplicating it", () => {
    expect(moveGroupTab(groups, "b", "left", "right")).toEqual([
      { id: "left", tabs: ["a"], activeId: "a", previewId: null },
      { id: "right", tabs: ["c", "b"], activeId: "b", previewId: null },
    ]);
  });

  it("merges unique tabs into the remaining group", () => {
    expect(mergeClosedGroup(groups, "right")).toEqual({
      id: "left",
      tabs: ["a", "b", "c"],
      activeId: "b",
      previewId: null,
    });
    expect(mergeClosedGroup([groups[0]], "left")).toBeNull();
  });

  it("opens a preview and replaces the existing preview in its slot", () => {
    const withPreview = openPreviewTab(groups, "left", "preview-a");
    expect(withPreview[0]).toEqual({
      id: "left",
      tabs: ["a", "b", "preview-a"],
      activeId: "preview-a",
      previewId: "preview-a",
    });

    expect(openPreviewTab(withPreview, "left", "preview-b")[0]).toEqual({
      id: "left",
      tabs: ["a", "b", "preview-b"],
      activeId: "preview-b",
      previewId: "preview-b",
    });
  });

  it("does not turn an existing permanent tab into a preview", () => {
    expect(openPreviewTab(groups, "left", "a")[0]).toEqual({
      ...groups[0],
      activeId: "a",
    });
  });

  it("pins a preview explicitly and when it is moved", () => {
    const withPreview = openPreviewTab(groups, "left", "preview");
    expect(pinGroupTab(withPreview, "left", "preview")[0].previewId).toBeNull();
    expect(moveGroupTab(withPreview, "preview", "left", "right")).toEqual([
      { id: "left", tabs: ["a", "b"], activeId: "b", previewId: null },
      {
        id: "right",
        tabs: ["c", "preview"],
        activeId: "preview",
        previewId: null,
      },
    ]);
  });

  it("clears a preview when it closes and pins previews during merge", () => {
    const leftPreview = openPreviewTab(groups, "left", "preview-left");
    const bothPreviews = openPreviewTab(leftPreview, "right", "preview-right");
    expect(closeGroupTab(bothPreviews, "right", "preview-right")[1]).toEqual({
      id: "right",
      tabs: ["c"],
      activeId: "c",
      previewId: null,
    });
    expect(mergeClosedGroup(bothPreviews, "right")).toEqual({
      id: "left",
      tabs: ["a", "b", "preview-left", "c", "preview-right"],
      activeId: "preview-left",
      previewId: null,
    });
  });
});
