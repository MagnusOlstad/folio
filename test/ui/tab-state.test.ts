import { describe, expect, it } from "vitest";

import type { TabGroup } from "../../src/domain/types.ts";
import {
  closeGroupTab,
  mergeClosedGroup,
  moveGroupTab,
} from "../../src/features/workspace/model/tab-state.ts";

const groups: TabGroup[] = [
  { id: "left", tabs: ["a", "b"], activeId: "b" },
  { id: "right", tabs: ["c"], activeId: "c" },
];

describe("workspace tab state", () => {
  it("selects an adjacent tab when the active tab closes", () => {
    expect(closeGroupTab(groups, "left", "b")[0]).toEqual({
      id: "left",
      tabs: ["a"],
      activeId: "a",
    });
  });

  it("moves a tab between groups without duplicating it", () => {
    expect(moveGroupTab(groups, "b", "left", "right")).toEqual([
      { id: "left", tabs: ["a"], activeId: "a" },
      { id: "right", tabs: ["c", "b"], activeId: "b" },
    ]);
  });

  it("merges unique tabs into the remaining group", () => {
    expect(mergeClosedGroup(groups, "right")).toEqual({
      id: "left",
      tabs: ["a", "b", "c"],
      activeId: "b",
    });
    expect(mergeClosedGroup([groups[0]], "left")).toBeNull();
  });
});
