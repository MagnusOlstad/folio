import { describe, expect, it } from "vitest";
import type { EntityMention } from "../../src/domain/entities.ts";
import { exactMentionRange, groupMentionsByType, visibleResolution } from "../../src/features/workspace/model/entity-view.ts";

function mention(overrides: Partial<EntityMention> = {}): EntityMention {
  return {
    id: "m1", bundleId: "b1", noteId: "n1", blockId: null, contentHash: "0".repeat(64),
    projectionVersion: 1, startUtf16: 0, endUtf16: 1, rawStartUtf16: 0, rawEndUtf16: 1,
    displayStartUtf16: 0, displayEndUtf16: 1, text: "A", type: "organization", score: 0.99,
    extractionFingerprint: null, provenance: {}, entityId: "e1", resolution: "resolved",
    resolutionProvenance: "model", status: "active", ...overrides,
  };
}

describe("entity view helpers", () => {
  it("checks exact UTF-16 spans including astral characters", () => {
    const content = "😀 Acme";
    expect(exactMentionRange(mention({ text: "Acme", displayStartUtf16: 3, displayEndUtf16: 7 }), content)).toEqual({ from: 3, to: 7 });
    expect(exactMentionRange(mention({ text: "Acme", displayStartUtf16: 2, displayEndUtf16: 6 }), content)).toBeNull();
    expect(exactMentionRange(mention({ text: "Acme", displayStartUtf16: 3, displayEndUtf16: 20 }), content)).toBeNull();
  });

  it("groups only active mentions and keeps ambiguous resolution visible", () => {
    const items = [mention(), mention({ id: "m2", type: "person", resolution: "ambiguous" }), mention({ id: "m3", status: "dismissed" })];
    expect(groupMentionsByType(items).map((group) => [group.type, group.mentions.length])).toEqual([["person", 1], ["organization", 1]]);
    expect(visibleResolution(items[1])).toBe("Ambiguous identity");
  });
});
